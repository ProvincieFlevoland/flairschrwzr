// tests of the link scheme check: admin-configured reference links become an
// anchor only when the parsed scheme is https or mailto; every `href={...}` in the Svelte sources goes through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLinkUrl } from '../src/lib/utils/safeUrl.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('https and mailto pass, and come back normalised', () => {
    assert.equal(safeLinkUrl('https://www.kcbr.nl/themas/themas-z/duidelijke-taal'), 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal');
    assert.equal(safeLinkUrl('  HTTPS://Example.NL/a?b=1#c  '), 'https://example.nl/a?b=1#c');
    assert.equal(safeLinkUrl('mailto:helpdesk@flevoland.nl'), 'mailto:helpdesk@flevoland.nl');
});

test('every other scheme, a path, a network-path reference and non-strings are refused', () => {
    const bad = [
        'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
        'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'blob:https://a/b', 'ftp://a/b', 'tel:+31612345678',
        'http://example.nl/', '//example.nl/a', '/relatief/pad', 'relatief', '', '   ', 'https://',
    ];
    for (const b of bad) assert.equal(safeLinkUrl(b), '', JSON.stringify(b));
    for (const v of [undefined, null, 12, {}, [], true]) assert.equal(safeLinkUrl(v), '', String(v));
    assert.equal(safeLinkUrl('https://example.nl/' + 'a'.repeat(3000)), '', 'absurdly long values');
});

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith('.svelte')) yield p;
    }
}

test('every href with a dynamic value in the Svelte sources goes through safeLinkUrl (or is the loader-checked doc URL)', () => {
    const found = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/\bhref=\{([^}]*)\}/g)) {
                const expr = m[1].trim();
                if (/^safeLinkUrl\(/.test(expr)) continue;
                if (expr === 'docUrl') continue; // config.b1_metrics_doc_url: loader.js and config.js accept http(s) or a root path only
                found.push(`${rel}:${i + 1}: href={${expr}}`);
            }
        });
    }
    assert.deepEqual(found, [], 'route the value through safeLinkUrl (utils/safeUrl.js) or document why it is safe');
});
