/**
 * Safety filter for nota HTML.
 *
 * Nota content is HTML that other people wrote (an auteur's own edits, a reviewer's spans, an AI answer applied
 * through a structuur accept) and that the editor writes back with `innerHTML`. Every place that turns stored nota
 * HTML into DOM passes it through `sanitizeNotaHtml` first: `Workspace.parseContentToBlocks`, the nota list load in
 * `NotaDashboard`, `BlockEditor.setContent` and the two reviewer-note rewrites in `Workspace`.
 *
 * What the filter does :
 *  - elements in REMOVED_WITH_CONTENT (script, style, iframe, object, embed and a few that never hold prose) are
 *    removed together with their content;
 *  - every other element that is not in ALLOWED_TAGS is replaced by its children (the text survives, the markup does not);
 *  - on a kept element only the attributes of ALLOWED_ATTR / `data-*` survive; every `on*` attribute and every URL
 *    attribute is removed; `class` keeps only the names that nota content really uses (ALLOWED_CLASS) and `style`
 *    survives only on `span` and only as `background-color` and `border-bottom` declarations with plain colour values
 *    (the reviewer spans), so a nota cannot position, cover or restyle the application;
 *  - when nothing had to be removed the ORIGINAL string is returned, byte for byte, so a stored nota that is already
 *    clean is not rewritten by loading it.
 *
 * The parse happens in an inert `<template>` document: scripts do not run and images do not load while the filter
 * looks at the markup, unlike `div.innerHTML = html` in the live document (`<img onerror>` fires there).
 *
 * Text that is meant as text must never reach `innerHTML` as it is: `escapeHtmlText` is the explicit conversion, and
 * `setNotaHtml(el, html)` is the ONE function that assigns nota HTML to `innerHTML` (tests/sink-audit.test.mjs fails
 * when another `innerHTML =`, `{@html}` or `insertAdjacentHTML` sink appears in `src/`). The filter is idempotent, so
 * it runs on the final string of every sink, also after a decode.
 *
 * `sanitizeTree` works on any DOM-like tree (childNodes, nodeType, localName, attributes, removeAttribute, removeChild,
 * insertBefore), so the policy is unit-tested in node with a small tree stand-in (tests/safety-filter.test.mjs) and in a
 * real browser by the end-to-end tests.
 */

// Elements kept as they are. `div` is here because Chrome's contenteditable writes `<div>` on Enter; `span` carries the
// reviewer notes (`span.reviewer-highlight[data-note-id]` with inline style) and the legacy `span.highlight-*`.
// Tests: tests/safety-filter.test.mjs.
const ALLOWED_TAGS = new Set(['p', 'i', 'b', 'u', 'ul', 'ol', 'li', 'br', 'strong', 'em', 'h2', 'span', 'div']);

// Removed with everything inside them. The first five carry script or styles; the rest never hold prose and are
// the usual carriers of script (noscript, template, svg, math) or of document-level side effects (link, meta, base).
const REMOVED_WITH_CONTENT = new Set([
    'script', 'style', 'iframe', 'object', 'embed',
    'noscript', 'template', 'svg', 'math', 'link', 'meta', 'base'
]);

// Attributes that occur in stored notas today: `class` (dynamic-chapter, reviewer-highlight, highlight-*), `data-chapter-id`,
// `data-note-id`, `data-sug-id` (any `data-*`), `style` (reviewer spans), `title` (reviewer span tooltip); `lang` and `dir`
// are harmless text metadata a browser may add.
const ALLOWED_ATTR = new Set(['class', 'style', 'title', 'lang', 'dir']);

// Class names that exist in notas or in the editor DOM that becomes a nota (derived from the fixtures and the source):
// `dynamic-chapter` (chapter headings), `reviewer-highlight` and `resolved` (Workspace reviewer notes), the legacy
// `highlight-<colour>` and `dynamic-highlight`, and the painted highlight classes of BlockEditor and SuggestionModal.
// Everything else (host utilities such as `fixed inset-0`, app classes such as `editor-cell expanded`) is dropped.
const ALLOWED_CLASS = /^(dynamic-chapter|dynamic-highlight|reviewer-highlight|resolved|suggestion-highlight|suggestion-highlight-active|hovered-from-sidebar|non-b1-word|source-(structuur|spelling|b1|woordenlijst)|highlight-[a-z0-9-]+)$/;

// The only inline style a nota has: `Workspace.addReviewerNote` sets `backgroundColor` and `borderBottom` on the span.
const COLOR = '(?:#[0-9a-f]{3,8}|rgba?\\([0-9.,%\\s/]+\\)|hsla?\\([0-9.,%\\sdeg/]+\\)|[a-z]{3,20})';
const STYLE_DECL = {
    'background-color': new RegExp('^' + COLOR + '$', 'i'),
    'border-bottom': new RegExp('^[0-9.]{1,4}px\\s+(?:solid|dashed|dotted)\\s+' + COLOR + '$', 'i')
};

/** Attributes whose value is a URL; checked even though no kept element carries them today (defence in depth). */
const URL_ATTR = new Set(['href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data', 'codebase', 'cite']);

/** @param {string} tag lower-case local name */
export function isAllowedTag(tag) {
    return ALLOWED_TAGS.has(tag);
}

/** @param {string} tag lower-case local name */
export function isRemovedWithContent(tag) {
    return REMOVED_WITH_CONTENT.has(tag);
}

/** `onclick`, `onerror`, ... (any attribute starting with `on`). */
export function isEventHandlerAttr(name) {
    return /^on/i.test(String(name));
}

/**
 * True when a URL value starts with `javascript:`, `data:` or `vbscript:` after the characters browsers ignore in a
 * scheme (whitespace, control characters, zero-width characters) are dropped.
 * @param {string} value
 */
export function isDangerousUrl(value) {
    const v = String(value).replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase();
    return v.startsWith('javascript:') || v.startsWith('data:') || v.startsWith('vbscript:');
}

/**
 * True when an inline style value cannot load or run anything. Reviewer spans carry `background-color` and
 * `border-bottom` only; CSS escapes and comments are dropped before the check so `u\72l(` does not slip through.
 * @param {string} value
 */
export function isSafeStyle(value) {
    const v = String(value)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd))
        .replace(/\\/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    return !(/url\(|expression\(|javascript:|vbscript:|@import|behavior:|-moz-binding|image-set\(|src\(/.test(v));
}

/**
 * @param {string} value a `class` attribute value
 * @returns {{ value: string, changed: boolean }} the allowed class names, space separated
 */
export function filterClass(value) {
    const tokens = String(value).split(/\s+/).filter(Boolean);
    const kept = tokens.filter((t) => ALLOWED_CLASS.test(t));
    return { value: kept.join(' '), changed: kept.length !== tokens.length };
}

/**
 * @param {string} value a `style` attribute value
 * @returns {{ value: string, changed: boolean }} only the declarations of STYLE_DECL with a plain value
 */
export function filterStyle(value) {
    if (!isSafeStyle(value)) return { value: '', changed: true };
    const decls = String(value).split(';').map((d) => d.trim()).filter(Boolean);
    const kept = [];
    for (const d of decls) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const prop = d.slice(0, i).trim().toLowerCase();
        const val = d.slice(i + 1).trim();
        if (Object.prototype.hasOwnProperty.call(STYLE_DECL, prop) && STYLE_DECL[prop].test(val)) kept.push(`${prop}: ${val}`);
    }
    return { value: kept.length ? kept.join('; ') + ';' : '', changed: kept.length !== decls.length };
}

// Known behaviour: the `is` attribute is not in ALLOWED_ATTR and is removed from the DOM, but Chromium
// re-serialises a customised built-in (`<p is="x-foo">`) that was already upgraded when the string is read back from
// `innerHTML`; the filter's output is then correct and the serialised cell can still carry `is=` (harmless unless the host
// page defines customised built-ins).
/**
 * Decides whether an attribute of a kept element survives.
 * @param {string} name attribute name
 * @param {string} value attribute value
 */
export function isAllowedAttr(name, value) {
    const n = String(name).toLowerCase();
    if (isEventHandlerAttr(n)) return false;
    if (URL_ATTR.has(n)) return false; // no kept element takes a URL; a javascript:/data: value would fail isDangerousUrl anyway
    if (n.startsWith('data-')) return true;
    if (!ALLOWED_ATTR.has(n)) return false;
    if (n === 'style') return filterStyle(value).value !== '' && !filterStyle(value).changed;
    if (n === 'class') return !filterClass(value).changed && String(value).trim() !== '';
    return true;
}

/** @param {any} node */
function isElement(node) {
    return node && node.nodeType === 1;
}

/**
 * Filters the children of `parent` in place and returns true when anything was removed or rewritten.
 * @param {any} parent a DOM node (or a stand-in) whose children are filtered
 * @returns {boolean}
 */
export function sanitizeTree(parent) {
    let changed = false;
    for (const child of Array.from(parent.childNodes)) {
        if (!isElement(child)) continue; // text and comments stay (a comment is inert and is serialised as a comment)
        const tag = String(child.localName || child.nodeName || '').toLowerCase();
        if (isRemovedWithContent(tag)) {
            parent.removeChild(child);
            changed = true;
            continue;
        }
        // children first: whatever is unwrapped below has been filtered already
        if (sanitizeTree(child)) changed = true;
        if (!isAllowedTag(tag)) {
            while (child.firstChild) parent.insertBefore(child.firstChild, child);
            parent.removeChild(child);
            changed = true;
            continue;
        }
        for (const attr of Array.from(child.attributes || [])) {
            const name = String(attr.name).toLowerCase();
            if (isAllowedAttr(attr.name, attr.value)) {
                if (name !== 'style' || tag === 'span') continue;
                child.removeAttribute(attr.name); // style on anything but a span
                changed = true;
            } else if ((name === 'class' || name === 'style') && !isEventHandlerAttr(name)) {
                // keep what is allowed of the value, drop the rest
                const f = name === 'class' ? filterClass(attr.value) : (tag === 'span' ? filterStyle(attr.value) : { value: '' });
                if (f.value && typeof child.setAttribute === 'function') child.setAttribute(attr.name, f.value);
                else child.removeAttribute(attr.name);
                changed = true;
            } else {
                child.removeAttribute(attr.name);
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * Filters a nota HTML string. Returns the input unchanged (same string) when nothing had to be removed, the
 * serialised clean markup otherwise. Non-strings and the empty string are returned as they are.
 * Fails closed without a DOM (returns the empty string): the filter has no way to look at the markup then.
 * @param {unknown} html
 * @returns {any}
 */
export function sanitizeNotaHtml(html) {
    if (typeof html !== 'string' || html === '') return html;
    if (typeof document === 'undefined') return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const inert = tpl.content.ownerDocument;
    const holder = inert.createElement('div');
    holder.appendChild(tpl.content);
    if (!sanitizeTree(holder)) return html;
    return holder.innerHTML;
}

/**
 * Filters the `content` of every nota of a list loaded from the backend (the list is changed in place and returned).
 * @param {Array<{ content?: unknown }>} notas
 */
export function sanitizeNotaList(notas) {
    if (!notas) return [];
    for (const n of notas) {
        if (n && typeof n.content === 'string') n.content = sanitizeNotaHtml(n.content);
    }
    return notas;
}

/**
 * Plain text to HTML text: `&`, `<` and `>` become entities. Use it wherever text (a text node's `textContent`, user
 * input) is concatenated into a string that is later parsed as HTML. NBSP and quotes are left as they are, so a clean
 * nota keeps its bytes.
 * @param {unknown} text
 */
export function escapeHtmlText(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The only place where nota HTML is assigned to `innerHTML`: the string is filtered first, so what lands in
 * the DOM never contains an element, attribute or style outside the allow-list, whatever produced the string.
 * @param {{ innerHTML: string }} el
 * @param {unknown} html
 */
export function setNotaHtml(el, html) {
    el.innerHTML = sanitizeNotaHtml(html == null ? '' : html);
}
