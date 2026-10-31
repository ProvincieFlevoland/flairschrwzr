/**
 * Plain text of a nota for the clipboard ("Kopieer Alles", Workspace.copyAll).
 *
 * Paragraphs, list items and `<br>` become line breaks, entities are decoded and NBSP is a plain space, and an
 * untouched instruction of the template (`<p><i>…</i></p>` whose text is one of the template's instructies, or one
 * of the generic placeholder phrases) is left out: the clipboard gets the nota, not the template. An instruction the
 * auteur edited no longer equals the template text and stays. A deliberately empty paragraph stays an empty line.
 *
 * Browser only: the block HTML is parsed into an inert `DOMParser` document, which runs nothing and loads nothing;
 * the HTML passed the safety filter when the nota was split into blocks (Workspace.parseContentToBlocks).
 */
import { decodeHtmlSpaceEntities } from './blockPlainText.js';
import { isTemplatePlaceholderText } from './notaTitle.js';

const BLOCK_ELEMENTS = 'p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr';
/** Marks a deliberately empty paragraph so the line normalisation keeps it as one empty line. */
const EMPTY_LINE = '\u0001';

/** Whitespace-normalised text, for comparing a paragraph with a template instruction. */
function normalisedText(s) {
    return decodeHtmlSpaceEntities(s).replace(/\s+/g, ' ').trim();
}

/** One line per paragraph: whitespace around a line break collapses into that break; no leading or trailing breaks. */
export function normaliseLines(text) {
    return String(text || '').replace(/[ \t]*\n[ \t\n]*/g, '\n').trim();
}

/**
 * Clipboard text of one block body.
 * @param {string|null|undefined} html
 * @param {{ placeholders?: string[] }} [opts] the template's instructies; an untouched one is left out
 * @returns {string}
 */
export function blockHtmlToClipboardText(html, opts = {}) {
    if (!html || !html.trim()) return '';
    const wanted = new Set((opts.placeholders || []).map(normalisedText).filter(Boolean));
    const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
    for (const p of Array.from(doc.body.querySelectorAll('p'))) {
        const only = p.children.length === 1 ? p.children[0] : null;
        if (!only || !/^(I|EM)$/.test(only.tagName)) continue;
        const text = normalisedText(p.textContent);
        if (text !== normalisedText(only.textContent)) continue; // text outside the italic part: the auteur wrote there
        if (wanted.has(text) || isTemplatePlaceholderText(text)) p.remove();
    }
    for (const el of Array.from(doc.body.querySelectorAll('p, div'))) {
        if (normalisedText(el.textContent) === '' && !el.querySelector('p, div')) el.textContent = EMPTY_LINE;
    }
    for (const br of Array.from(doc.body.querySelectorAll('br'))) br.replaceWith('\n');
    // a break on both sides: the editor stores a first line as a bare text node followed by a <div> for the next one
    for (const el of Array.from(doc.body.querySelectorAll(BLOCK_ELEMENTS))) { el.prepend('\n'); el.append('\n'); }
    return normaliseLines(decodeHtmlSpaceEntities(doc.body.textContent)).split(EMPTY_LINE).join('');
}

/**
 * The whole nota: `${title}\n${body}` per block, the title alone when the body is empty, blocks separated by a blank line.
 * @param {Array<{ title?: string, content?: string }>} blocks Workspace.parseContentToBlocks
 * @param {{ placeholders?: string[] }} [opts]
 * @returns {string}
 */
export function notaBlocksToClipboardText(blocks, opts = {}) {
    return (blocks || []).map((b) => {
        const title = String(b?.title || '').trim();
        const body = blockHtmlToClipboardText(b?.content, opts);
        return body ? `${title}\n${body}` : title;
    }).join('\n\n');
}
