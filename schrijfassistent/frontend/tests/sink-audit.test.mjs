// audit of the HTML sinks: nota HTML becomes DOM through `setNotaHtml` only.
// A new `innerHTML =`, `{@html}`, `insertAdjacentHTML`, `outerHTML =` or `document.write` anywhere in src/ fails this test
// until it is routed through utils/safetyFilter.js or added to the allow-list below with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** file (relative to src/) -> reason; the helper itself and the Node-only fallback of the paste sanitiser */
const ALLOWED = new Map([
    ['lib/utils/safetyFilter.js', 'the filter: its inert template parse and setNotaHtml are the one sink'],
    ['lib/utils/pasteSanitize.js', 'fallback without DOMParser (Node unit tests only); the browser path parses with DOMParser']
]);

// The other routes from a string to the DOM or to code are covered as well.
const SINK = /\.innerHTML\s*(\+?=)(?!=)|\{@html\b|\binsertAdjacentHTML\s*\(|\.outerHTML\s*(\+?=)(?!=)|\bdocument\.write(ln)?\s*\(|\bexecCommand\s*\(\s*['"]insertHTML|\bcreateContextualFragment\s*\(|\b(setHTMLUnsafe|parseHTMLUnsafe)\s*\(|\.srcdoc\s*=|\bsrcdoc\s*=|\beval\s*\(|\bnew\s+Function\s*\(/;

/** `Range.insertNode` inserts DOM that the code built itself (paste sanitiser fragment, text nodes, the highlight span). A new use needs a review: pinned per file. */
const INSERT_NODE_REVIEWED = new Map([['lib/components/BlockEditor.svelte', 4]]);

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.(svelte|js|mjs|ts)$/.test(name)) yield p;
    }
}

test('no HTML sink outside utils/safetyFilter.js (and the documented fallback)', () => {
    const found = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
            if (SINK.test(line)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(found, [], 'route these through setNotaHtml or extend ALLOWED with a reason');
});

test('the audit sees a sink when there is one (self-check of the pattern)', () => {
    for (const bad of ['document.execCommand("insertHTML", false, h)', 'r.createContextualFragment(h)', 'el.setHTMLUnsafe(h)', 'f.srcdoc = h', 'eval(x)', 'new Function("a")', 'el.innerHTML = x;', 'el.innerHTML += x', 'a.b.innerHTML=c', '{@html foo}', 'x.insertAdjacentHTML("beforeend", y)', 'el.outerHTML = z', 'document.write(q)']) {
        assert.ok(SINK.test(bad), bad);
    }
    for (const ok of ['const h = el.innerHTML;', 'if (a.innerHTML === b) {}', 'onupdate(editorRef.innerHTML)', 'x.innerText = y']) {
        assert.equal(SINK.test(ok), false, ok);
    }
});

test('Range.insertNode is used only where it was reviewed (pinned count per file)', () => {
    const found = new Map();
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const n = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\.insertNode\s*\(/.test(l)).length;
        if (n) found.set(rel, n);
    }
    assert.deepEqual(Object.fromEntries(found), Object.fromEntries(INSERT_NODE_REVIEWED), 'review the new insertNode use (is the node built from text or a sanitised fragment?) and update the pinned count');
});
