// Unit tests of the nota safety filter.
// The policy and the tree walk are tested in node on a small DOM stand-in (no DOM library is needed); the same filter runs on a real parse in the end-to-end tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    sanitizeTree,
    sanitizeNotaHtml,
    sanitizeNotaList,
    isAllowedTag,
    isAllowedAttr,
    isDangerousUrl,
    isSafeStyle,
    isEventHandlerAttr,
    isRemovedWithContent,
    filterClass,
    filterStyle,
    escapeHtmlText,
    setNotaHtml
} from '../src/lib/utils/safetyFilter.js';

// ---- a minimal tree: elements, text, comments; enough of the Node API for sanitizeTree ----
class Node {
    constructor(nodeType, localName = '', data = '') {
        this.nodeType = nodeType;
        this.localName = localName;
        this.data = data;
        this.childNodes = [];
        this.parentNode = null;
        this.attributes = [];
    }
    get firstChild() {
        return this.childNodes[0] || null;
    }
    appendChild(n) {
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes.push(n);
        return n;
    }
    insertBefore(n, ref) {
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
        return n;
    }
    removeChild(n) {
        const i = this.childNodes.indexOf(n);
        assert.ok(i >= 0, 'removeChild: not a child');
        this.childNodes.splice(i, 1);
        n.parentNode = null;
        return n;
    }
    removeAttribute(name) {
        this.attributes = this.attributes.filter((a) => a.name !== name);
    }
    setAttribute(name, value) {
        const a = this.attributes.find((x) => x.name === name);
        if (a) a.value = value;
        else this.attributes.push({ name, value });
    }
}
const el = (tag, attrs = {}, kids = []) => {
    const n = new Node(1, tag);
    n.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    for (const k of kids) n.appendChild(typeof k === 'string' ? text(k) : k);
    return n;
};
const text = (s) => new Node(3, '#text', s);
const comment = (s) => new Node(8, '#comment', s);
const root = (...kids) => el('div', {}, kids);
/** serialises a tree to a string, attributes in their order */
function ser(n) {
    if (n.nodeType === 3) return n.data;
    if (n.nodeType === 8) return `<!--${n.data}-->`;
    if (n.localName === 'div' && !n.parentNode) return n.childNodes.map(ser).join('');
    const a = n.attributes.map((x) => ` ${x.name}="${x.value}"`).join('');
    return `<${n.localName}${a}>${n.childNodes.map(ser).join('')}</${n.localName}>`;
}

test('the elements and attributes of stored notas pass unchanged (the filter is a no-op on a clean nota)', () => {
    const tree = root(
        el('h2', { class: 'dynamic-chapter', 'data-chapter-id': 'h1' }, ['Onderwerp']),
        text('\n'),
        el('p', {}, ['Tekst met ', el('strong', {}, ['vet']), ' en ', el('em', {}, ['schuin']), el('br'), 'en ', el('b', {}, ['b']), el('i', {}, ['i']), el('u', {}, ['u'])]),
        el('ul', {}, [el('li', {}, ['een'])]),
        el('ol', {}, [el('li', {}, ['twee'])]),
        el('p', {}, [
            el('span', { class: 'reviewer-highlight', 'data-note-id': 'note-1', style: 'background-color: rgba(59, 130, 246, 0.19); border-bottom: 2px solid rgb(59, 130, 246);', title: 'Notitie van Judge (Vraag): tekst...' }, ['gemarkeerd']),
            el('span', { class: 'highlight-yellow dynamic-highlight', 'data-sug-id': 'r3' }, ['legacy'])
        ]),
        el('div', {}, [el('br')]),
        comment(' inert ')
    );
    const before = ser(tree);
    assert.equal(sanitizeTree(tree), false, 'nothing changed');
    assert.equal(ser(tree), before);
});

test('p survives: the allow-list holds every allowed element', () => {
    for (const tag of ['p', 'i', 'b', 'u', 'ul', 'ol', 'li', 'br', 'strong', 'em', 'h2', 'span', 'div']) {
        assert.equal(isAllowedTag(tag), true, `${tag} is allowed`);
    }
    const tree = root(el('p', {}, ['alinea']));
    assert.equal(sanitizeTree(tree), false);
    assert.equal(ser(tree), '<p>alinea</p>', 'paragraph kept');
});

test('script, style, iframe, object and embed are removed with their content', () => {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed']) {
        const tree = root(el('p', {}, ['voor']), el(tag, { src: 'x' }, ['payload']), el('p', {}, ['na']));
        assert.equal(sanitizeTree(tree), true, tag);
        assert.equal(ser(tree), '<p>voor</p><p>na</p>', `${tag} removed`);
    }
    for (const tag of ['noscript', 'template', 'svg', 'math', 'link', 'meta', 'base']) {
        assert.equal(isRemovedWithContent(tag), true, tag);
    }
});

test('a script nested in an unknown element is removed and the unknown element is unwrapped', () => {
    const tree = root(el('svg', {}, [el('script', {}, ['alert(1)'])]), el('font', { color: 'red' }, ['rood ', el('script', {}, ['x']), el('em', {}, ['schuin'])]));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), 'rood <em>schuin</em>', 'svg removed whole, font unwrapped, its script gone, its text and em kept');
});

test('unknown elements are replaced by their children (text survives)', () => {
    const tree = root(el('a', { href: 'javascript:alert(1)' }, ['link']), el('img', { src: 'x', onerror: 'alert(1)' }), el('table', {}, [el('tr', {}, [el('td', {}, ['cel'])])]));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), 'linkcel');
});

test('on* attributes are removed, the other attributes of the element stay', () => {
    const tree = root(el('p', { class: 'dynamic-chapter', onclick: 'alert(1)', onmouseover: 'x', ONFOCUS: 'y' }, ['t']));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), '<p class="dynamic-chapter">t</p>');
    assert.equal(isEventHandlerAttr('onerror'), true);
    assert.equal(isEventHandlerAttr('class'), false);
    assert.equal(isAllowedAttr('onclick', 'x'), false);
});

test('href and src never survive, javascript: and data: values are recognised through whitespace and case tricks', () => {
    assert.equal(isAllowedAttr('href', 'https://example.org'), false, 'no kept element takes a URL');
    assert.equal(isAllowedAttr('src', 'x.png'), false);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' \tjava\nscript:alert(1)', '\u0001javascript:x', 'data:text/html,<script>x</script>', 'DATA:image/svg+xml;base64,AAAA', 'vbscript:x', 'java\u200bscript:x']) {
        assert.equal(isDangerousUrl(bad), true, JSON.stringify(bad));
    }
    for (const ok of ['https://example.org/a', '/pad', '#anker', 'mailto:a@b.nl', 'datastore.nl']) {
        assert.equal(isDangerousUrl(ok), false, ok);
    }
});

test('style: the reviewer span style passes; anything that can load or run something goes', () => {
    assert.equal(isSafeStyle('background-color: rgba(59, 130, 246, 0.19); border-bottom: 2px solid rgb(59, 130, 246);'), true);
    for (const bad of ['background: url(javascript:alert(1))', 'background:URL( "x" )', 'width: expression(alert(1))', 'background: u\\72l(x)', 'background: ur/**/l(x)', '@import "x"', 'behavior: url(x)', '-moz-binding: url(x)']) {
        assert.equal(isSafeStyle(bad), false, bad);
    }
    const tree = root(el('span', { class: 'reviewer-highlight', style: 'background: url(javascript:alert(1))' }, ['x']));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), '<span class="reviewer-highlight">x</span>', 'only the style attribute is dropped');
    // a style on anything but a span goes, even a harmless one
    const p = root(el('p', { style: 'background-color: red;' }, ['t']));
    assert.equal(sanitizeTree(p), true);
    assert.equal(ser(p), '<p>t</p>');
});

test('data-* attributes are kept, id and other unknown attributes are dropped', () => {
    assert.equal(isAllowedAttr('data-note-id', 'note-1'), true);
    assert.equal(isAllowedAttr('data-chapter-id', 'h1'), true);
    assert.equal(isAllowedAttr('id', 'x'), false);
    assert.equal(isAllowedAttr('contenteditable', 'true'), false);
});

test('sanitizeNotaHtml: non-strings and the empty string pass through, without a DOM it fails closed', () => {
    assert.equal(typeof document, 'undefined', 'this test runs without a DOM');
    assert.equal(sanitizeNotaHtml(''), '');
    assert.equal(sanitizeNotaHtml(null), null);
    assert.equal(sanitizeNotaHtml(undefined), undefined);
    assert.equal(sanitizeNotaHtml(42), 42);
    assert.equal(sanitizeNotaHtml('<p>x</p>'), '', 'no DOM: nothing can be inspected, so nothing is let through');
});

test('sanitizeNotaList filters the content of every nota and leaves the rest alone', () => {
    const list = [{ id: 'a', content: '' }, { id: 'b' }, { id: 'c', content: 5 }];
    assert.deepEqual(sanitizeNotaList(list), [{ id: 'a', content: '' }, { id: 'b' }, { id: 'c', content: 5 }]);
    assert.deepEqual(sanitizeNotaList(null), []);
});

test('class: only the names nota content uses survive; host utilities and app layout classes are dropped', () => {
    assert.deepEqual(filterClass('dynamic-chapter'), { value: 'dynamic-chapter', changed: false });
    assert.deepEqual(filterClass('highlight-yellow dynamic-highlight'), { value: 'highlight-yellow dynamic-highlight', changed: false });
    assert.deepEqual(filterClass('reviewer-highlight resolved'), { value: 'reviewer-highlight resolved', changed: false });
    assert.deepEqual(filterClass('suggestion-highlight source-spelling hovered-from-sidebar'), { value: 'suggestion-highlight source-spelling hovered-from-sidebar', changed: false });
    assert.deepEqual(filterClass('fixed inset-0 z-50 reviewer-highlight'), { value: 'reviewer-highlight', changed: true });
    assert.deepEqual(filterClass('editor-cell expanded'), { value: '', changed: true });
    const tree = root(el('div', { class: 'editor-cell expanded' }, ['x']), el('span', { class: 'fixed inset-0 reviewer-highlight', 'data-note-id': 'n1' }, ['y']));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), '<div>x</div><span class="reviewer-highlight" data-note-id="n1">y</span>');
});

test('style: only background-color and border-bottom with plain colours, only on span; position, z-index, url and expression go', () => {
    const reviewer = 'background-color: rgba(59, 130, 246, 0.19); border-bottom: 2px solid rgb(59, 130, 246);';
    assert.deepEqual(filterStyle(reviewer), { value: reviewer, changed: false });
    const hex = 'background-color: #8b5cf630; border-bottom: 2px solid #8b5cf6;';
    assert.deepEqual(filterStyle(hex), { value: hex, changed: false });
    const mixed = filterStyle('position:fixed; left:0; background-color: red; z-index: 2147483647; border-bottom: 2px solid blue');
    assert.deepEqual(mixed, { value: 'background-color: red; border-bottom: 2px solid blue;', changed: true });
    for (const bad of ['position: fixed', 'z-index: 9', 'background: url(x)', 'background-color: expression(alert(1))', 'background-color: red !important', 'width: 100vw; height: 100vh', 'border-bottom: 2px solid url(x)']) {
        assert.equal(filterStyle(bad).value, '', bad);
        assert.equal(filterStyle(bad).changed, true, bad);
    }
    const tree = root(el('span', { style: 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:2147483647' }, ['overlay']));
    assert.equal(sanitizeTree(tree), true);
    assert.equal(ser(tree), '<span>overlay</span>');
    const keep = root(el('span', { class: 'reviewer-highlight', style: 'position:fixed; background-color: red' }, ['k']));
    assert.equal(sanitizeTree(keep), true);
    assert.equal(ser(keep), '<span class="reviewer-highlight" style="background-color: red;">k</span>');
});

test('plain text to HTML: escapeHtmlText makes text inert and round trips', () => {
    const hostile = ['<img src=x onerror=window.__pwn=1>', '<script>alert(1)</script>', 'a &lt;b&gt; c', '<svg onload=alert(1)>', 'Tom & Jerry', '"quoted" \u00a0nbsp', '</p><p onclick=x>'];
    const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const h of hostile) {
        const e = escapeHtmlText(h);
        assert.equal(/<[a-z!/?]/i.test(e), false, `no tag start left in ${JSON.stringify(e)}`);
        assert.equal(unescape(e), h, 'the text is recovered');
    }
    assert.equal(escapeHtmlText('plain text\n'), 'plain text\n', 'a clean text keeps its bytes');
    assert.equal(escapeHtmlText(null), '');
    // the round trip a stored text node takes: stored entities -> text node -> escapeHtmlText -> the same entities
    assert.equal(escapeHtmlText('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
});

test('setNotaHtml assigns the filtered string (no DOM here: fail closed, empty)', () => {
    const el = { innerHTML: 'x' };
    setNotaHtml(el, '<p>hi</p>');
    assert.equal(el.innerHTML, '', 'without a DOM nothing is let through');
    setNotaHtml(el, null);
    assert.equal(el.innerHTML, '');
});

test('Workspace.parseContentToBlocks escapes text nodes and every sink writes through setNotaHtml (source check)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ws = readFileSync(path.join(here, '../src/lib/components/Workspace.svelte'), 'utf8');
    assert.ok(ws.includes('node.nodeType === 3 ? escapeHtmlText(node.textContent) : node.outerHTML'), 'text nodes are escaped');
    const be = readFileSync(path.join(here, '../src/lib/components/BlockEditor.svelte'), 'utf8');
    assert.ok(be.includes('setNotaHtml(editorRef, block.content);'), 'the editor writes block.content through the filter');
});
