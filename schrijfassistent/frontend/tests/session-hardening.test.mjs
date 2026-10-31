// Unit tests of session hardening: lost-PUT recovery, the conflict
// copy and its lifecycle, the close confirmation kinds, teardown of a session, a full or blocked
// localStorage, the retry policy, literal trigger words and the guard on null suggestion items.
import { register } from 'node:module';
import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib') + '/').href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec.startsWith('$lib/')) return next(${JSON.stringify(lib)} + spec.slice(5), ctx);
  return next(spec, ctx);
}`));

const mem = new Map();
let failWrites = false;
const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
        if (failWrites) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
        mem.set(k, String(v));
    },
    removeItem: (k) => { mem.delete(k); },
    key: (i) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
};
globalThis.localStorage = localStorage;
globalThis.window = { localStorage };

let store, api, auto, keys, copy, closeSeq, safeStorage, notifications, suggestions, analysis;
const notes = () => { let v; notifications.subscribe((x) => { v = x; })(); return v.map((t) => t.message); };

before(async () => {
    store = await import('../src/lib/store.js');
    api = await import('../src/lib/apiClient.js');
    auto = await import('../src/lib/autosaveStore.js');
    keys = await import('../src/lib/storageKeys.js');
    copy = await import('../src/lib/conflictCopy.js');
    closeSeq = await import('../src/lib/closeSequence.js');
    safeStorage = await import('../src/lib/safeStorage.js');
    notifications = (await import('../src/lib/notificationStore.js')).notifications;
    suggestions = await import('../src/lib/utils/suggestions.js');
    analysis = await import('../src/lib/utils/analysis.js');
});

beforeEach(() => {
    mem.clear();
    failWrites = false;
    api.setTokenProvider(null);
    keys.setStorageUserId('u-1');
    notifications.set([]);
    auto.resetAutoSaveState();
    auto.setAutosaveTornDown(false);
    safeStorage.resetStorageWarning();
    store.resetStoreState();
});

const T0 = '2026-07-01T10:00:00.000Z';
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
/** A scripted backend: each PUT takes the next step; GET of a nota answers `stored`. */
function scripted(steps, calls, stored) {
    let i = 0;
    return async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push({ url: String(url), method, headers: init.headers, body: init.body, credentials: init.credentials });
        if (method === 'GET') return { ok: true, status: 200, json: async () => stored };
        const step = steps[i++];
        if (!step) throw new Error('unexpected PUT');
        if (step === 'lost') throw abortError();
        if (typeof step === 'number') return { ok: step < 300, status: step, json: async () => ({}) };
        return { ok: false, status: 409, json: async () => ({ detail: { error: 'conflict', stored_last_modified: step.storedLast } }) };
    };
}
const setupNota = (id, lastModified = T0, base = '2026-07-01T09:00:00.000Z') => {
    const nota = { id, title: 'titel', content: '<p>tekst</p>', lastModified };
    store.dbStore.set({ notas: [nota], users: [], configurations: [] });
    store.rememberNotaBase([{ id, lastModified: base }]);
    return nota;
};
const edit = (id, lastModified) => store.dbStore.update((d) => ({ ...d, notas: d.notas.map((n) => (n.id === id ? { ...n, lastModified } : n)) }));

describe('lost PUT response', () => {
    it('a 409 caused by our own unconfirmed write is adopted and resent once, without a toast', async () => {
        const calls = [];
        globalThis.fetch = scripted(['lost', { storedLast: T0 }, 200], calls);
        setupNota('n-lost');
        await assert.rejects(store.syncNotaToAzure('n-lost'), (e) => e.name === 'AbortError');
        edit('n-lost', '2026-07-01T10:00:05.000Z');
        await store.syncNotaToAzure('n-lost');
        const puts = calls.filter((c) => c.method === 'PUT');
        assert.equal(puts.length, 3);
        assert.equal(puts[1].headers['X-Nota-Base-Modified'], '2026-07-01T09:00:00.000Z', 'the second attempt still carries the old base');
        assert.equal(puts[2].headers['X-Nota-Base-Modified'], T0, 'the resend carries the stored lastModified as base');
        assert.equal(JSON.parse(puts[2].body).lastModified, '2026-07-01T10:00:05.000Z', 'and the newest text');
        assert.equal(store.isNotaConflicted('n-lost'), false);
        assert.deepEqual(notes(), []);
        assert.equal(store.getNotaBase('n-lost'), '2026-07-01T10:00:05.000Z');
    });

    it('a gateway 5xx also leaves the outcome unknown', async () => {
        const calls = [];
        globalThis.fetch = scripted([504, { storedLast: T0 }, 200], calls);
        setupNota('n-504');
        await assert.rejects(store.syncNotaToAzure('n-504'), (e) => e.status === 504);
        await store.syncNotaToAzure('n-504');
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
        assert.equal(store.isNotaConflicted('n-504'), false);
    });

    it('a 409 whose stored version is neither ours by timestamp nor by content is a real conflict', async () => {
        const calls = [];
        const other = { id: 'n-real', title: 'van een ander', content: '<p>anders</p>', lastModified: '2026-07-01T09:30:00.000Z' };
        globalThis.fetch = scripted(['lost', { storedLast: other.lastModified }], calls, other);
        setupNota('n-real');
        await assert.rejects(store.syncNotaToAzure('n-real'));
        await assert.rejects(store.syncNotaToAzure('n-real'), (e) => e.name === 'NotaConflictError' && e.reported);
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 2, 'no third attempt');
        assert.equal(store.isNotaConflicted('n-real'), true);
        assert.equal(notes().filter((m) => m === store.CONFLICT_MESSAGE).length, 1);
    });

    it('when the timestamp differs but the stored nota equals the body we sent, it is our own write', async () => {
        const calls = [];
        const nota = setupNota('n-eq');
        const sentBody = JSON.parse(JSON.stringify(nota));
        globalThis.fetch = scripted(['lost', { storedLast: 'some-other-stamp' }, 200], calls, { ...sentBody });
        await assert.rejects(store.syncNotaToAzure('n-eq'));
        await store.syncNotaToAzure('n-eq');
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
        assert.equal(store.isNotaConflicted('n-eq'), false);
    });

    it('without an unconfirmed attempt a 409 is a conflict at once, and nothing is read back', async () => {
        const calls = [];
        globalThis.fetch = scripted([{ storedLast: T0 }], calls);
        setupNota('n-plain');
        await assert.rejects(store.syncNotaToAzure('n-plain'), (e) => e.name === 'NotaConflictError');
        assert.equal(calls.length, 1);
    });

    it('the resend is made once: a second 409 is a conflict', async () => {
        const calls = [];
        globalThis.fetch = scripted(['lost', { storedLast: T0 }, { storedLast: T0 }], calls);
        setupNota('n-once');
        await assert.rejects(store.syncNotaToAzure('n-once'));
        await assert.rejects(store.syncNotaToAzure('n-once'), (e) => e.name === 'NotaConflictError');
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
        assert.equal(store.isNotaConflicted('n-once'), true);
    });

    it('a confirmed save forgets the unconfirmed attempts', async () => {
        const calls = [];
        globalThis.fetch = scripted(['lost', 200, { storedLast: T0 }], calls);
        setupNota('n-clear');
        await assert.rejects(store.syncNotaToAzure('n-clear'));
        await store.syncNotaToAzure('n-clear');
        edit('n-clear', '2026-07-01T11:00:00.000Z');
        await assert.rejects(store.syncNotaToAzure('n-clear'), (e) => e.name === 'NotaConflictError');
        assert.equal(calls.filter((c) => c.method === 'GET').length, 0);
    });
});

describe('conflict copy lifecycle and plain text', () => {
    const body = (title, content) => JSON.stringify({ id: 'x', title, content });
    class FakeDomParser {
        parseFromString(html) {
            // top level only: block elements and bare text between them, like a real body
            const childNodes = [...html.matchAll(/<(h2|p)[^>]*>([\s\S]*?)<\/\1>|([^<]+)/g)].map((m) => ({ textContent: (m[2] ?? m[3] ?? '').replace(/<[^>]*>/g, '') }));
            return { body: { childNodes } };
        }
    }

    it('keeps at most five copies per user and drops the oldest', () => {
        for (let i = 1; i <= 7; i++) copy.stashConflictCopy(`n${i}`, body(`t${i}`, '<p>x</p>'));
        const stored = [...mem.keys()].filter((k) => k.startsWith('gs_nota_conflict:u-1:'));
        assert.equal(stored.length, 5);
        assert.equal(copy.getConflictCopy('n1'), null);
        assert.ok(copy.getConflictCopy('n7'));
    });

    it('a copy over the size cap lives in memory only', () => {
        const big = body('groot', 'x'.repeat(copy.MAX_BYTES + 10));
        copy.stashConflictCopy('n-big', big);
        assert.equal(mem.has('gs_nota_conflict:u-1:n-big'), false);
        assert.equal(copy.getConflictCopy('n-big'), big);
    });

    it('is removed when that nota is loaded again, and when the session is reset', () => {
        copy.stashConflictCopy('n-a', body('a', '<p>1</p>'));
        copy.stashConflictCopy('n-b', body('b', '<p>2</p>'));
        store.rememberNotaBase([{ id: 'n-a', lastModified: T0 }]);
        assert.equal(mem.has('gs_nota_conflict:u-1:n-a'), false, 'reloaded nota');
        assert.equal(mem.has('gs_nota_conflict:u-1:n-b'), true, 'other nota untouched');
        store.resetStoreState();
        assert.equal([...mem.keys()].some((k) => k.startsWith('gs_nota_conflict:')), false, 'close, logout or user switch');
    });

    it('does not touch the copies of another user', () => {
        copy.stashConflictCopy('n-a', body('a', '<p>1</p>'));
        keys.setStorageUserId('u-2');
        copy.clearConflictCopies();
        assert.equal(mem.has('gs_nota_conflict:u-1:n-a'), true);
    });

    it('turns the refused version into plain text and copies it to the clipboard', async () => {
        globalThis.DOMParser = FakeDomParser;
        let written = null;
        Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { written = t; } } }, configurable: true });
        copy.stashConflictCopy('n-t', body('Mijn titel', '<h2>Kop</h2>Losse tekst<p>Eerste <b>zin</b>.</p>'));
        assert.equal(copy.conflictCopyPlainText(copy.getConflictCopy('n-t')), 'Mijn titel\n\nKop\n\nLosse tekst\n\nEerste zin.');
        assert.equal(await copy.copyConflictCopy('n-t'), true);
        assert.equal(written, 'Mijn titel\n\nKop\n\nLosse tekst\n\nEerste zin.');
        assert.equal(await copy.copyConflictCopy('n-none'), false);
    });
});

describe('close confirmation kinds', () => {
    it('picks the kind in the order conflict, saving, pending, unsaved', () => {
        const k = closeSeq.closeConfirmationKind;
        assert.equal(k('idle'), '');
        assert.equal(k('idle', { conflicted: true }), 'conflict');
        assert.equal(k('saving', { conflicted: true }), 'conflict');
        assert.equal(k('saving'), 'saving');
        assert.equal(k('pending', { dirtyUnsaved: true }), 'pending');
        assert.equal(k('idle', { dirtyUnsaved: true }), 'unsaved');
        assert.equal(closeSeq.needsCloseConfirmation('idle'), false);
        assert.equal(closeSeq.needsCloseConfirmation('idle', { conflicted: true }), true);
    });

    it('isNotaDirty compares the nota with the base of its last load or save', async () => {
        const calls = [];
        globalThis.fetch = scripted([200], calls);
        setupNota('n-d', '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z');
        assert.equal(store.isNotaDirty('n-d'), false);
        edit('n-d', '2026-07-01T09:05:00.000Z');
        assert.equal(store.isNotaDirty('n-d'), true);
        await store.syncNotaToAzure('n-d');
        assert.equal(store.isNotaDirty('n-d'), false);
        store.dbStore.update((d) => ({ ...d, notas: [...d.notas, { id: 'n-new', lastModified: T0 }] }));
        assert.equal(store.isNotaDirty('n-new'), true, 'never saved');
    });
});

describe('teardown of a session', () => {
    it('abortAllRequests aborts what is in flight and bumps the generation; every request omits credentials', async () => {
        let seenSignal; let seenCreds;
        globalThis.fetch = (url, init) => new Promise((_res, rej) => {
            seenSignal = init.signal; seenCreds = init.credentials;
            init.signal.addEventListener('abort', () => rej(abortError()));
        });
        const g0 = api.getGeneration();
        const p = api.storageFetch('/notas');
        assert.equal(seenCreds, 'omit');
        api.abortAllRequests();
        await assert.rejects(p, (e) => e.name === 'AbortError');
        assert.equal(seenSignal.aborted, true);
        assert.notEqual(api.getGeneration(), g0);
        assert.equal(api.isCurrentGeneration(g0), false);
        // the next session's requests are not aborted
        let signal2;
        globalThis.fetch = async (url, init) => { signal2 = init.signal; return { ok: true, status: 200 }; };
        await api.storageFetch('/notas');
        assert.equal(signal2.aborted, false);
    });

    it('a save that finishes after the session ended writes no base and no unconfirmed attempt', async () => {
        let release;
        globalThis.fetch = async () => { await new Promise((r) => { release = r; }); return { ok: true, status: 200 }; };
        setupNota('n-s', T0, '2026-07-01T09:00:00.000Z');
        const p = store.syncNotaToAzure('n-s');
        await new Promise((r) => setTimeout(r, 5));
        api.abortAllRequests();
        release();
        await assert.rejects(p);
        assert.equal(store.getNotaBase('n-s'), '2026-07-01T09:00:00.000Z', 'the next session does not inherit this answer');
    });

    it('resetStoreState forgets bases, conflicts and the in-memory database', () => {
        setupNota('n-r');
        copy.stashConflictCopy('n-r', '{}');
        store.resetStoreState();
        assert.equal(store.getNotaBase('n-r'), undefined);
        assert.equal(store.isNotaConflicted('n-r'), false);
        let db; store.dbStore.subscribe((v) => { db = v; })();
        assert.deepEqual(db.notas, []);
    });

    it('a torn-down autosave arms no debounce, and a sleeping retry stops after a reset', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let calls = 0;
            auto.setAutosaveTornDown(true);
            auto.startDebounceTimer('n', async () => { calls++; });
            mock.timers.tick(10500);
            assert.equal(calls, 0);
            auto.setAutosaveTornDown(false);
            let attempts = 0;
            const p = auto.triggerImmediateAutoSave('n', async () => { attempts++; throw new Error('HTTP 500'); });
            await Promise.resolve(); await Promise.resolve();
            auto.resetAutoSaveState();
            mock.timers.tick(5000);
            await p;
            assert.equal(attempts, 1, 'no second attempt after the reset');
        } finally { mock.timers.reset(); }
    });
});

describe('retry policy', () => {
    it('a 401, 403 or 404 is not retried, a 500 and a 429 are', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            for (const [status, expected] of [[401, 1], [403, 1], [404, 1], [413, 1], [500, 3], [429, 3], [408, 3]]) {
                notifications.set([]);
                let attempts = 0;
                const p = auto.triggerImmediateAutoSave('n', async () => {
                    attempts++;
                    throw Object.assign(new Error(`HTTP ${status}`), { status });
                });
                for (let i = 0; i < 6; i++) { await Promise.resolve(); mock.timers.tick(5000); }
                await p;
                assert.equal(attempts, expected, `status ${status}`);
                auto.resetAutoSaveState();
            }
        } finally { mock.timers.reset(); }
    });

    it('a 401 says that the session may have expired', async () => {
        await auto.triggerImmediateAutoSave('n', async () => { throw Object.assign(new Error('HTTP 401'), { status: 401 }); });
        assert.ok(notes().some((m) => m.includes('sessie is mogelijk verlopen')));
    });
});

describe('a full or blocked localStorage', () => {
    it('saveDB, the settings and the toggle never throw; one toast per mount; the in-memory state carries on', () => {
        failWrites = true;
        store.dbStore.set({ notas: [{ id: 'n-q', lastModified: T0 }], users: [], configurations: [] });
        for (let i = 0; i < 5; i++) assert.doesNotThrow(() => store.saveDB());
        assert.doesNotThrow(() => auto.isAutoSaveEnabled.set(false));
        let on; auto.isAutoSaveEnabled.subscribe((v) => { on = v; })();
        assert.equal(on, false, 'the toggle holds in memory although the write failed');
        assert.equal(notes().filter((m) => m === safeStorage.STORAGE_FULL_MESSAGE).length, 1);
        safeStorage.resetStorageWarning();
        store.saveDB();
        assert.equal(notes().filter((m) => m === safeStorage.STORAGE_FULL_MESSAGE).length, 2, 'a new mount warns again');
    });

    it('a missing localStorage object does not throw either', () => {
        const saved = globalThis.window;
        globalThis.window = {};
        try {
            assert.equal(safeStorage.storageGet('k'), null);
            assert.equal(safeStorage.storageSet('k', 'v', { silent: true }), false);
            assert.deepEqual(safeStorage.storageKeysWithPrefix('k'), []);
        } finally { globalThis.window = saved; }
    });

    it('the autosave still sends to the backend without the cache', async () => {
        failWrites = true;
        const calls = [];
        globalThis.fetch = scripted([200], calls);
        setupNota('n-q2');
        store.saveDB();
        await store.syncNotaToAzure('n-q2');
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    });
});

describe('literal trigger words', () => {
    class FakeRange { setStart(n, o) { this.s = o; } setEnd(n, o) { this.e = o; } }
    class FakeHighlight { constructor(...r) { this.ranges = r; } }
    function run(text, suggestions) {
        const node = { textContent: text };
        const map = new Map();
        globalThis.CSS = { highlights: map };
        globalThis.Highlight = FakeHighlight;
        globalThis.Range = FakeRange;
        globalThis.NodeFilter = { SHOW_TEXT: 4 };
        let done = false;
        globalThis.document = { createTreeWalker: () => ({ nextNode: () => (done ? null : ((done = true), node)) }) };
        globalThis.window = { CSS: globalThis.CSS, localStorage };
        analysis.applyRealtimeHighlights({}, suggestions);
        return map.get('sa-ai-suggestions')?.ranges ?? [];
    }
    it('regex syntax, empty entries and catastrophic patterns match as text and return at once', () => {
        const t0 = Date.now();
        const ranges = run('a* (a+)+$ ' + 'a'.repeat(22) + '! attenderen', [
            { original: '' }, { original: 'a*' }, { original: '(a+)+$' }, { original: '[' }, { original: 'attenderen' }, { original: null },
        ]);
        assert.ok(Date.now() - t0 < 1000, 'no freeze');
        const texts = ranges.map((r) => [r.s, r.e]);
        assert.ok(texts.some(([s, e]) => e - s === 'attenderen'.length), 'the plain word still matches');
        assert.ok(texts.some(([s, e]) => e - s === 2), '"a*" matches the literal two characters, not every "a"');
        assert.ok(ranges.length < 10);
    });
    it('caps the number of ranges', () => {
        const ranges = run('x'.repeat(20000), [{ original: 'x' }]);
        assert.ok(ranges.length <= 5000);
    });
});

describe('null items in an AI answer', () => {
    it('are skipped instead of throwing', () => {
        const rows = suggestions.feedbackToSuggestions(
            { Suggesties: [null, 5, 'tekst', [], { Origineel: 'een tekst', Suggestie: 'een betere tekst', Uitleg: 'omdat' }] },
            'block-h1', 'h1', 'agent_b1', 'dit is een tekst'
        );
        assert.ok(Array.isArray(rows));
    });
});

describe('link policy', () => {
    it('refuses credentials in the URL', async () => {
        const { safeLinkUrl } = await import('../src/lib/utils/safeUrl.js');
        assert.equal(safeLinkUrl('https://user:pass@example.nl/'), '');
        assert.equal(safeLinkUrl('https://user@example.nl/'), '');
        assert.equal(safeLinkUrl('https://example.nl/'), 'https://example.nl/');
    });
    it('the Direct Duidelijk documentation link follows the same rule as every other link', async () => {
        const { setRuntimeConfig, b1MetricsDocUrl } = await import('../src/lib/config.js');
        for (const [v, out] of [['https://www.kcbr.nl/', 'https://www.kcbr.nl/'], ['http://a.nl/', ''], ['/docs/x', ''], ['/\\evil.example', ''], ['javascript:alert(1)', '']]) {
            setRuntimeConfig({ b1_metrics_doc_url: v });
            assert.equal(b1MetricsDocUrl(), out, v);
        }
    });
});

describe('main.js teardown wiring', () => {
    it('destroy() aborts requests, clears the timers, disables and resets the autosave, then resets the store, in that order', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('function destroy()'), src.indexOf('/** Unmounts the app;'));
        const order = ['abortAllRequests()', 'clearAllWorkspaceTimers()', 'setAutosaveTornDown(true)', 'resetAutoSaveState()', 'svelteUnmount(', 'resetStoreState()'].map((x) => body.indexOf(x));
        assert.ok(order.every((i) => i >= 0), 'every step is present');
        assert.deepEqual([...order].sort((a, b) => a - b), order, 'in order');
        const mountBody = src.slice(src.indexOf('export function mount('), src.indexOf('function destroy()'));
        assert.ok(mountBody.indexOf('destroy()') < mountBody.indexOf('setStorageUserId('), 'the previous user is torn down before the next user id is set');
        assert.match(mountBody, /setWorkspaceDisposed\(false\)[\s\S]*setAutosaveTornDown\(false\)/, 'a new mount lifts the teardown flags');
    });
});
