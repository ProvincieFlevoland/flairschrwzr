// Unit tests for the two build-time CSS checks: scope check incl. @font-face, dark twin ties.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkCss } from '../scripts/check-css-scope.mjs';
import { checkDarkTwins, specificity } from '../scripts/check-dark-twins.mjs';

describe('check-css-scope', () => {
    it('accepts scoped selectors, the highlight rule and sa- keyframes', () => {
        const css = `.sa-root .a{color:red} .dark .sa-root .a{color:blue} ::highlight(sa-ai-suggestions){background:#ff0} @keyframes sa-x{from{opacity:0}to{opacity:1}}`;
        assert.deepEqual(checkCss(css), []);
    });
    it('rejects selectors outside .sa-root and unprefixed keyframes', () => {
        const v = checkCss(`body{margin:0} .btn{color:red} @keyframes spin{from{opacity:0}to{opacity:1}} @import "x.css";`);
        assert.equal(v.length, 4);
    });
    it('rejects every sibling escape of the container', () => {
        for (const sel of ['.sa-root + .host', '.sa-root ~ .host', '.sa-root:hover + .host-banner', '.sa-root.open ~ .host', '.sa-root:has(+ .x)', '.dark .sa-root:hover ~ .x']) {
            assert.equal(checkCss(`${sel}{color:red}`).length, 1, sel);
        }
        assert.deepEqual(checkCss('.sa-root .a + .b{color:red} .sa-root .a ~ .b{color:red} .sa-root:not(.x) .a{color:red}'), []);
    });
    it('accepts a Phosphor @font-face with relative same-origin urls', () => {
        const css = `@font-face{font-family:"Phosphor";src:url(./fonts/Phosphor.abc.woff2) format("woff2"),url("fonts/Phosphor.abc.woff") format("woff");font-display:block}
@font-face{font-family:sa-icons;src:url(./fonts/x.woff2)}
@font-face{font-family:Phosphor-Bold;src:url(./fonts/b.woff2?v=1)}`;
        assert.deepEqual(checkCss(css), []);
    });
    it('rejects an @font-face with a foreign family or a non-relative url', () => {
        assert.equal(checkCss(`@font-face{font-family:Inter;src:url(./fonts/i.woff2)}`).length, 1);
        for (const u of ['https://unpkg.com/x.woff2', '//cdn.example/x.woff2', '/static/x.woff2', 'data:font/woff2;base64,AAAA', '../x.woff2', './../x.woff2', 'javascript:1']) {
            assert.equal(checkCss(`@font-face{font-family:Phosphor;src:url("${u}")}`).length, 1, u);
        }
        assert.equal(checkCss(`@font-face{font-family:Phosphor}`).length, 1, 'no src');
    });
});

describe('check-dark-twins', () => {
    it('computes specificity', () => {
        assert.deepEqual(specificity('.dark .sa-root .a:hover'), [0, 4, 0]);
        assert.deepEqual(specificity('.sa-root .a.svelte-1abc:hover'), [0, 4, 0]);
        assert.deepEqual(specificity('.sa-root div::before'), [0, 1, 2]);
    });
    it('passes a twin that is one class heavier', () => {
        const r = checkDarkTwins(`.sa-root .a{color:#111} .dark .sa-root .a{color:#eee}`);
        assert.equal(r.ties.length, 0);
        assert.equal(r.uncovered.length, 0);
    });
    it('flags the Svelte hash tie', () => {
        const css = `.dark .sa-root .nota-list-item:hover{border-color:#4b5563} .sa-root .nota-list-item.svelte-1gyhk4k:hover{border-color:#cbd5e1}`;
        const r = checkDarkTwins(css);
        assert.equal(r.ties.length, 1);
        assert.match(r.ties[0].light, /svelte-1gyhk4k/);
    });
    it('passes the twin inside the component (same hash class)', () => {
        const css = `.sa-root .nota-list-item.svelte-1gyhk4k:hover{border-color:#cbd5e1} .dark .sa-root .nota-list-item.svelte-1gyhk4k:hover{border-color:#4b5563}`;
        assert.equal(checkDarkTwins(css).ties.length, 0);
    });
    it('lists light colour rules without twin', () => {
        const r = checkDarkTwins(`.dark .sa-root .a{color:#eee} .sa-root .b{color:#111}`);
        assert.equal(r.ties.length, 0);
        assert.deepEqual(r.uncovered.map((u) => u.selector), ['.sa-root .b']);
    });
    it('ignores variable-driven colours', () => {
        assert.equal(checkDarkTwins(`.sa-root .c{color:var(--sa-text-main);background:var(--sa-bg-main)}`).uncovered.length, 0);
    });
});

it('check-css-scope rejects sibling combinators after the scope and document-global at-rules', () => {
    for (const bad of ['.sa-root + .leak { color: red }', '.sa-root ~ div { color: red }', '.dark .sa-root + .x { color: red }', '@property --x { syntax: "*"; inherits: false }', '@page { margin: 0 }']) {
        assert.equal(checkCss(bad).length, 1, bad);
    }
    for (const ok of ['.sa-root .a + .b { color: red }', '.dark .sa-root > .a { color: red }', '@media (min-width: 1px) { .sa-root .a { color: red } }', '@keyframes sa-x { from { opacity: 0 } }']) {
        assert.equal(checkCss(ok).length, 0, ok);
    }
});
