// tests of the configurator: the pure helpers of src/lib/adminConfig.js, source level guards on
// AdminDashboard.svelte and App.svelte (role gate, no native dialogs, no reload, no stub) and the done-gate of the dark twins.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    MAX_IMPORT_BYTES, MAX_IMPORT_DEPTH, MAX_IMPORT_STRING, MAX_IMPORT_CHAPTERS, MAX_IMPORT_RULES, validateConfigId, segmentProblem, itemIdProblem,
    workingConfigItemProblem, jsonDepthExceeds, parseImportText, buildUploadPayload, configFromImport, exportFileName, ruleWordList,
} from '../src/lib/adminConfig.js';
import { viewForRole, homeViewFor, startsAsAuthor } from '../src/lib/identityAdapter.js';
import { naturalSort } from '../src/lib/utils/sorting.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const sort = (a, f) => naturalSort(a, f);

describe('validateConfigId', () => {
    it('accepts ordinary ids and trims them', () => {
        assert.deepEqual(validateConfigId('conf-gs'), { ok: true, id: 'conf-gs' });
        assert.deepEqual(validateConfigId('  GS-nota v5 '), { ok: true, id: 'GS-nota v5' });
        assert.equal(validateConfigId('x'.repeat(128)).ok, true);
    });
    it('refuses what would wipe or escape the folder', () => {
        for (const bad of ['', '   ', undefined, null, 5, 'notas', 'NOTAS', ' Notas ', 'a/b', 'a\\b', '/', '.', '..', 'a\nb', 'a\u0000b', 'x'.repeat(129)]) {
            const r = validateConfigId(bad);
            assert.equal(r.ok, false, JSON.stringify(bad));
            assert.equal(typeof r.reason, 'string');
        }
    });
    it('refuses the characters that change the target of a request and what the backend refuses', () => {
        for (const bad of ['a?b', 'a#b', 'a%b', 'GS-nota v5 #2', 'a%2Fb', 'a..b', '.a', 'a.', 'zero\u200bwidth', 'bidi\u202eflip', 'a:b', 'a*b', 'a<b']) {
            assert.equal(validateConfigId(bad).ok, false, bad);
        }
        for (const good of ['GS-nota v5', 'h1', 'conf-1700000000000', 'Ë ok', 'a_b.c', 'x']) assert.equal(validateConfigId(good).ok, true, good);
    });
    it('keeps ids that merely contain the reserved word', () => {
        assert.equal(validateConfigId('notas-2').ok, true);
        assert.equal(validateConfigId('mijn notas').ok, true);
    });
});

describe('item ids and import caps', () => {
    it('itemIdProblem accepts ids without an id, text ids and integers; refuses path-like ones', () => {
        assert.equal(itemIdProblem([{ id: 'h1' }, { x: 1 }, { id: 5 }, { id: '' }], 'Hoofdstukken'), null);
        for (const bad of ['../../notas/n7', 'a/b', '..', 'a?b', 'a\\b', {}, ['a'], 1.5, true]) {
            assert.match(String(itemIdProblem([{ id: bad }], 'Regels')), /Regels: het item-id/, JSON.stringify(bad));
        }
        assert.equal(itemIdProblem(undefined, 'x'), null);
        assert.ok(workingConfigItemProblem({ templateGuidelines: [{ id: 'h1' }], rules: [{ id: '../x' }] }));
        assert.equal(workingConfigItemProblem({ templateGuidelines: [{ id: 'h1' }] }), null);
    });
    it('configFromImport refuses path-like item ids', () => {
        assert.throws(() => configFromImport({ templateGuidelines: [{ id: '../../notas/n1760000000001' }] }, sort), /item-id/);
        assert.throws(() => configFromImport({ templateGuidelines: [], rules: [{ id: '../../notas/n1760000000002' }] }, sort), /item-id/);
        assert.throws(() => configFromImport({ mappen: { hoofdstukken: [], regels: [{ id: 'a/b' }] } }, sort), /item-id/);
    });
    it('jsonDepthExceeds counts brackets outside strings', () => {
        assert.equal(jsonDepthExceeds('['.repeat(MAX_IMPORT_DEPTH) + ']'.repeat(MAX_IMPORT_DEPTH)), false);
        assert.equal(jsonDepthExceeds('['.repeat(MAX_IMPORT_DEPTH + 1)), true);
        assert.equal(jsonDepthExceeds('{"a":"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[["}'), false, 'brackets in a string do not count');
        assert.equal(jsonDepthExceeds('{"a":"\\"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[["}'), false, 'an escaped quote does not end the string');
        assert.equal(jsonDepthExceeds('['.repeat(900000)), true, 'huge nesting is refused in linear time');
    });
    it('parseImportText: deep, huge and long input is refused, the real shape passes', () => {
        const t0 = Date.now();
        assert.throws(() => parseImportText('['.repeat(900000) + ']'.repeat(900000)), /te diep genest/);
        assert.ok(Date.now() - t0 < 2000);
        assert.throws(() => parseImportText(JSON.stringify({ name: 'x'.repeat(MAX_IMPORT_STRING + 1) })), /tekst van meer dan/);
        assert.throws(() => parseImportText(JSON.stringify({ ['k'.repeat(MAX_IMPORT_STRING + 1)]: 1 })), /naam van meer dan/);
        assert.throws(() => parseImportText(JSON.stringify({ a: Array.from({ length: 200001 }, () => 1) })), /te veel gegevens/);
        assert.deepEqual(parseImportText('{"a":[1,{"b":"c"}]}'), { a: [1, { b: 'c' }] });
        // The 135 kB fixture lives in schrijfassistent/dev/fixtures, outside the frontend folder; the Docker build context holds only
        // schrijfassistent/frontend, so the check runs when the repository is present and is skipped in the image.
        const v5Path = path.join(ROOT, '../dev/fixtures/config/GS-nota-v5.upload.json');
        if (existsSync(v5Path)) assert.ok(parseImportText(readFileSync(v5Path, 'utf8')));
        assert.throws(() => parseImportText('{niet json'), SyntaxError);
    });
    it('chapter and rule counts are capped', () => {
        const many = (n) => Array.from({ length: n }, (_, i) => ({ id: 'h' + i }));
        assert.throws(() => configFromImport({ templateGuidelines: many(MAX_IMPORT_CHAPTERS + 1) }, sort), /te veel items/);
        assert.throws(() => configFromImport({ templateGuidelines: [], rules: many(MAX_IMPORT_RULES + 1) }, sort), /te veel items/);
        assert.equal(configFromImport({ templateGuidelines: many(MAX_IMPORT_CHAPTERS) }, sort).templateGuidelines.length, MAX_IMPORT_CHAPTERS);
    });
});

describe('viewForRole and homeViewFor (the role gate as behaviour)', () => {
    const beheerder = { role: 'beheerder' };
    const auteur = { role: 'auteur' };
    it('only a beheerder keeps the admin view', () => {
        assert.equal(viewForRole('admin', beheerder), 'admin');
        for (const u of [auteur, { role: 'reviewer' }, { role: '' }, {}, null, undefined, { role: 'admin' }]) assert.equal(viewForRole('admin', u), 'dashboard', JSON.stringify(u));
        for (const v of ['dashboard', 'editor']) for (const u of [beheerder, auteur, null]) assert.equal(viewForRole(v, u), v);
    });
    it('homeViewFor: everyone lands on the nota overview; the configurator is opened from the header', () => {
        assert.equal(homeViewFor(beheerder), 'dashboard');
        assert.equal(homeViewFor(beheerder, true), 'dashboard');
        assert.equal(homeViewFor(auteur), 'dashboard');
        assert.equal(homeViewFor(null), 'dashboard');
    });
    it('startsAsAuthor: a beheerder starts acting as auteur, so the overview is a working one', () => {
        assert.equal(startsAsAuthor(beheerder), true);
        for (const u of [auteur, { role: 'reviewer' }, { role: 'admin' }, {}, null, undefined]) assert.equal(startsAsAuthor(u), false, JSON.stringify(u));
    });
});

describe('every id in a storage URL is encoded', () => {
    it('no storageFetch of /configurations/ or /notas/ interpolates a raw value', () => {
        const stack = [path.join(ROOT, 'src')];
        const offenders = [];
        while (stack.length) {
            const d = stack.pop();
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) stack.push(p);
                else if (/\.(svelte|js)$/.test(e.name)) {
                    for (const m of readFileSync(p, 'utf8').matchAll(/storageFetch\(`(\/(?:configurations|notas)\/[^`]*)`/g)) {
                        const raw = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).filter((x) => !/^encodeURIComponent\(\w+\)$/.test(x));
                        if (raw.length) offenders.push(`${path.relative(ROOT, p)}: ${m[1]}`);
                    }
                }
            }
        }
        assert.deepEqual(offenders, []);
    });
});

describe('buildUploadPayload', () => {
    it('shapes the upload body', () => {
        const wc = { id: 'c1', name: 'N', templateVersion: 'v1', templateGuidelines: [{ id: 'h1' }], rules: [{ id: 'a', category: 'Terminologie' }, { id: 'b', category: 'B1 Taal' }], woordenlijst: ['x'], b1Guidelines: { a: 1 } };
        assert.deepEqual(buildUploadPayload(wc, 'c1'), {
            c1: { name: 'N', templateVersion: 'v1', description: '', toneOfVoice: 'Zakelijk', isActive: true, mappen: { hoofdstukken: [{ id: 'h1' }], terminologie: [{ id: 'a', category: 'Terminologie' }], regels: [{ id: 'b', category: 'B1 Taal' }], woordenlijst: ['x'] }, b1Guidelines: { a: 1 } },
        });
    });
    it('carries every edited metadata field (name, version, description, tone, isActive) into the body', () => {
        const p = buildUploadPayload({ id: 'x', name: 'Nieuw', templateVersion: 'v9', description: 'Beschrijving', toneOfVoice: 'Formeel', isActive: false, templateGuidelines: [], rules: [], woordenlijst: [] }, 'x');
        assert.deepEqual(p, { x: { name: 'Nieuw', templateVersion: 'v9', description: 'Beschrijving', toneOfVoice: 'Formeel', isActive: false, mappen: { hoofdstukken: [], terminologie: [], regels: [], woordenlijst: [] } } });
    });
    it('defaults missing lists, keeps isActive false, leaves out absent b1Guidelines', () => {
        const p = buildUploadPayload({ name: 'N', isActive: false }, 'k');
        assert.equal(p.k.isActive, false);
        assert.deepEqual(p.k.mappen, { hoofdstukken: [], terminologie: [], regels: [], woordenlijst: [] });
        assert.equal('b1Guidelines' in p.k, false);
        assert.equal('b1Guidelines' in buildUploadPayload({ name: 'N', b1Guidelines: null }, 'k').k, false);
    });
});

describe('configFromImport', () => {
    it('reads the flat export format', () => {
        const c = configFromImport({ name: 'A', templateVersion: '2', description: 'd', toneOfVoice: 'Warm', isActive: true, templateGuidelines: [{ id: 'h10' }, { id: 'h2' }], rules: [{ id: 'r' }], b1Guidelines: { z: 1 }, woordenlijst: ['w'] }, sort, 1700000000000);
        assert.equal(c.id, 'conf-1700000000000');
        assert.equal(c.name, 'A (Import)');
        assert.deepEqual(c.templateGuidelines.map((g) => g.id), ['h2', 'h10'], 'natural order');
        assert.equal(c.isActive, true);
        assert.deepEqual(c.woordenlijst, ['w'], 'the woordenlijst of the file is kept');
        assert.deepEqual(c.b1Guidelines, { z: 1 });
    });
    it('reads the storage format and merges terminologie and regels', () => {
        const c = configFromImport({ 'GS-nota v5': { name: 'S', mappen: { hoofdstukken: [{ id: 'h1' }], terminologie: [{ id: 't' }], regels: [{ id: 'r' }] } } }, sort, 1);
        assert.deepEqual(c.rules.map((r) => r.id), ['t', 'r']);
        assert.equal(c.templateVersion, '1.0'); assert.equal(c.toneOfVoice, 'Zakelijk'); assert.equal(c.isActive, false);
        assert.deepEqual(c.woordenlijst, [], 'no woordenlijst in the file, none in the copy');
        const w = configFromImport({ S: { name: 'S', mappen: { hoofdstukken: [], woordenlijst: ['a', 'b', 3] } } }, sort, 1);
        assert.deepEqual(w.woordenlijst, ['a', 'b'], 'storage format: the woordenlijst of mappen, strings only');
    });
    it('uses the defaults of the original for missing fields', () => {
        const c = configFromImport({ templateGuidelines: [] }, sort, 5);
        assert.equal(c.name, 'Geïmporteerde Config (Import)');
        assert.deepEqual(c.rules, []);
    });
    it('only an explicit true activates', () => {
        assert.equal(configFromImport({ templateGuidelines: [], isActive: 'true' }, sort).isActive, false);
        assert.equal(configFromImport({ templateGuidelines: [], isActive: 1 }, sort).isActive, false);
    });
    it('rejects input that is not a configuration with a Dutch error', () => {
        for (const bad of [null, undefined, 3, 'x', [], [null], true]) assert.throws(() => configFromImport(bad, sort), /JSON-object/, JSON.stringify(bad));
        assert.throws(() => configFromImport({ templateGuidelines: 'x' }, sort), /moet een lijst zijn/);
        assert.throws(() => configFromImport({ templateGuidelines: [null] }, sort), /alleen objecten/);
        assert.throws(() => configFromImport({ templateGuidelines: [], rules: 'abc' }, sort), /moet een lijst zijn/);
        assert.throws(() => configFromImport({ mappen: { hoofdstukken: [], terminologie: 'x' } }, sort), /moet een lijst zijn/);
        assert.throws(() => configFromImport({ templateGuidelines: [], rules: [1] }, sort), /alleen objecten/);
    });
    it('keeps hostile text as text and a non-object b1Guidelines as given', () => {
        const c = configFromImport({ name: '<img src=x onerror=alert(1)>', templateGuidelines: [], b1Guidelines: 'tekst' }, sort);
        assert.equal(c.name, '<img src=x onerror=alert(1)> (Import)');
        assert.equal(c.b1Guidelines, 'tekst');
    });
    it('a name that is not text does not throw', () => {
        assert.equal(configFromImport({ name: { a: 1 }, templateGuidelines: [] }, sort).name, 'Geïmporteerde Config (Import)');
        assert.equal(configFromImport({ name: 7, templateGuidelines: [] }, sort).name, '7 (Import)');
    });
});

describe('small helpers', () => {
    it('import limit and export name', () => {
        assert.equal(MAX_IMPORT_BYTES, 10 * 1024 * 1024);
        assert.equal(exportFileName('GS-nota v5'), 'GS-nota_v5_config.json');
        assert.equal(exportFileName('a  b\tc'), 'a_b_c_config.json');
        assert.equal(exportFileName(undefined), '_config.json');
    });
    it('ruleWordList reads arrays, comma strings and nothing else', () => {
        assert.deepEqual(ruleWordList(['a', 'b']), ['a', 'b']);
        assert.deepEqual(ruleWordList(['a', 3, null, '']), ['a', '']);
        assert.deepEqual(ruleWordList(' kaas, ham ,, '), ['kaas', 'ham']);
        for (const v of [undefined, null, 5, {}, true]) assert.deepEqual(ruleWordList(v), []);
    });
});

describe('AdminDashboard and App source guards', () => {
    const admin = read('src/lib/components/AdminDashboard.svelte');
    // the code without comment lines and trailing // comments, for the "never used" guards
    const code = admin.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/|<!--)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
    const app = read('src/App.svelte');
    it('the stub is gone and the real view is mounted for the beheerder', () => {
        assert.equal(existsSync(path.join(ROOT, 'src/lib/components/stubs/AdminViewStub.svelte')), false);
        assert.doesNotMatch(app, /AdminViewStub/);
        assert.match(app, /<AdminDashboard\b/);
    });
    it('App decides the view through viewForRole and homeViewFor (behaviour: see the tests of viewForRole and the SSR render)', () => {
        assert.match(app, /\$: currentView = viewForRole\(currentView, currentUser\);/);
        assert.doesNotMatch(app, /role === 'beheerder'/, 'no second, hand written role comparison in App.svelte');
    });
    it('no native dialog, no page reload, no direct fetch', () => {
        assert.doesNotMatch(code, /\balert\(/);
        assert.doesNotMatch(code, /\bconfirm\(/);
        assert.doesNotMatch(code, /location\.reload|location\.href|window\.open/);
        assert.doesNotMatch(code, /\bfetch\(/);
    });
    it('the save checks the id first and the import goes through the validator', () => {
        assert.match(admin, /validateConfigId\(workingConfig\.id\)/);
        assert.match(admin, /configFromImport\(/);
        assert.match(admin, /if \(file\.size > MAX_IMPORT_BYTES\) \{/);
        assert.match(admin, /buildUploadPayload\(/);
    });
    it('the view stops its own work on destroy', () => {
        assert.match(admin, /onDestroy\(/);
        assert.match(admin, /clearInterval/);
        assert.match(admin, /viewAbort\.abort\(\)/);
    });
    it('delete is the typed confirmation, also for sections', () => {
        assert.equal((admin.match(/<DeleteConfigModal/g) || []).length, 2);
        assert.match(admin, /itemType="sectie"/);
    });
    it('createNewNota filters the chapter markup and the sidebar reads rule words through ruleWordList', () => {
        assert.match(app, /initialContent = sanitizeNotaHtml\(initialContent\)/);
        assert.match(read('src/lib/components/AuteurPane.svelte'), /ruleWordList\(rule\.triggerWords\)/);
    });
    it('the admin view waits for the page level configuration load', () => {
        assert.match(app, /configsLoaded/);
        assert.match(app, /data-admin-loading/);
    });
    it('no HTML sink outside the audited ones in AdminDashboard', () => {
        assert.doesNotMatch(code, /\{@html/);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML/);
    });
});

describe('dark twin done-gate on the built CSS', () => {
    const dist = path.join(ROOT, 'dist');
    const built = existsSync(dist) && readdirSync(dist).some((f) => /^schrijfassistent\..*\.css$/.test(f));
    it('has no ties and no uncovered light rule', { skip: !built && 'no dist (run vite build)' }, () => {
        const r = spawnSync('node', ['scripts/check-dark-twins.mjs'], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /, 0 specificity tie/);
        assert.match(r.stdout, /, 0 light colour rule\(s\) without twin/);
    });
});
