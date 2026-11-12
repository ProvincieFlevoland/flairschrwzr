/**
 * Counting words, sentences and paragraphs in code instead of by the language model.
 *
 * Same rules as the backend (`backend/app/core/text_count.py`); `tests/fixtures/text-count-cases.json` holds the
 * shared cases both test suites check, so the two stay the same.
 *
 *  - A word is a run of characters between spaces that holds at least one letter or digit. Punctuation never counts
 *    on its own ("-", "–", "•", "&", "€") and never splits a word ("GS-voorstel", "e-Docs", "4-5", "50.000",
 *    "parkeergarage," are one word each).
 *  - A list marker at the start of a line ("1.", "1.1", "2)", "a)", "a.") is not a word.
 *  - A paragraph (alinea) is a non-empty line: each Enter in the editor starts a new one, as in Word.
 *  - A sentence ends at ".", "!", "?" or "…" followed by a space or the end of the text, and at the end of a line
 *    unless the next line goes on with a lower-case letter. A full stop after a known abbreviation ("bijv.", "o.a.",
 *    "art.", "d.w.z."), an initial ("J.") or a list marker does not end a sentence; "enz." and "etc." do only when a
 *    capital follows.
 */

/** Abbreviations after which a full stop never ends the sentence (lower case, without the final full stop). */
export const ABBREVIATIONS = new Set([
    'a.s', 'afd', 'art', 'artt', 'b.v', 'bijl', 'bijv', 'blz', 'bv', 'ca', 'd.d', 'd.m.v', 'd.w.z', 'dhr', 'dr',
    'drs', 'excl', 'evt', 'fig', 'gem', 'hfst', 'i.c', 'i.o.m', 'i.p.v', 'i.s.m', 'i.v.m', 'incl', 'ing', 'ir',
    'jl', 'j.l', 'jr', 'm.b.t', 'm.i.v', 'm.u.v', 'max', 'mevr', 'min', 'mr', 'mw', 'n.a.v', 'n.v.t', 'nr', 'nrs',
    'o.a', 'o.b.v', 'o.i.d', 'p', 'pag', 'par', 'prof', 'resp', 'sr', 't.a.v', 't.b.v', 't.g.v', 't.o.v', 't.w',
    't.z.t', 'tel', 'vgl', 'vs', 'w.o', 'z.s.m', 'zgn'
]);

/** Abbreviations that often close a sentence: the full stop ends it only when a capital follows. */
export const SENTENCE_FINAL_ABBREVIATIONS = new Set(['e.a', 'e.d', 'e.v', 'enz', 'etc']);

const DOTTED_ABBREVIATION = /^(?:\p{L}\.)+\p{L}?$/u;
const LIST_MARKER = /^(?:\(?\d{1,3}[.)]|\d{1,3}(?:\.\d{1,3})+\.?|\(?[a-zA-Z]\)|[a-z]\.)$/;
const TERMINATOR = /([.!?…]+)["'”’»)\]]*(?=\s|$)/gu;
const OPENING_PUNCTUATION = /^["'“‘„«([{]+/u;
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

const isUpper = (ch) => /^\p{Lu}$/u.test(ch);
const isLower = (ch) => /^\p{Ll}$/u.test(ch);

/** True when the token holds at least one letter or digit. */
export function isWord(token) {
    return /[\p{L}\p{N}]/u.test(token);
}

export function isListMarker(token) {
    return LIST_MARKER.test(token);
}

/**
 * The words of `text`. With `lineStart`, a list marker as the first token is not counted.
 * @param {string} text
 * @param {boolean} [lineStart]
 * @returns {string[]}
 */
export function wordsIn(text, lineStart = false) {
    let tokens = String(text || '').split(/\s+/).filter(Boolean);
    if (lineStart && tokens.length && isListMarker(tokens[0])) tokens = tokens.slice(1);
    return tokens.filter(isWord);
}

/**
 * Non-empty lines, each with its whitespace collapsed.
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
    return String(text || '')
        .replace(/ /g, ' ')
        .split(LINE_BREAK)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0);
}

/** Number of words in `text`, line by line so a list marker at the start of each line is left out. */
export function countWords(text) {
    return splitParagraphs(text).reduce((n, line) => n + wordsIn(line, true).length, 0);
}

function tokenBefore(line, end) {
    const start = line.lastIndexOf(' ', end - 1) + 1;
    return line.slice(start, end).replace(OPENING_PUNCTUATION, '');
}

function nextChar(line, pos) {
    return line.slice(pos).trimStart().slice(0, 1);
}

function endsSentence(line, match) {
    const punct = match[1];
    const punctStart = match.index;
    const matchEnd = match.index + match[0].length;
    if (punct.includes('!') || punct.includes('?')) return true;
    const nxt = nextChar(line, matchEnd);
    if (!nxt) return true;
    if (punct.includes('…') || punct.includes('..')) {
        // An ellipsis followed by a lower-case word goes on with the same sentence.
        return !isLower(nxt);
    }
    const token = tokenBefore(line, punctStart);
    const key = token.toLowerCase();
    if (!key) return true;
    if (punctStart - token.length === 0 && isListMarker(`${token}.`)) return false;
    if (SENTENCE_FINAL_ABBREVIATIONS.has(key)) return isUpper(nxt);
    if (ABBREVIATIONS.has(key) || DOTTED_ABBREVIATION.test(`${key}.`)) return false;
    if (key.length === 1 && /^\p{L}$/u.test(key)) return false; // an initial: "J. Jansen"
    return true;
}

/**
 * The sentences of `text`, each as one line of text (a sentence can run over a line break).
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
    const sentences = [];
    let current = '';
    const paragraphs = splitParagraphs(text);
    paragraphs.forEach((line, index) => {
        let start = 0;
        for (const match of line.matchAll(TERMINATOR)) {
            if (endsSentence(line, match)) {
                const end = match.index + match[0].length;
                current = `${current} ${line.slice(start, end)}`.trim();
                if (wordsIn(current, true).length) sentences.push(current);
                current = '';
                start = end;
            }
        }
        current = `${current} ${line.slice(start)}`.trim();
        const following = paragraphs[index + 1] || '';
        const first = following.split(' ')[0];
        const continues = Boolean(current) && isLower(following.slice(0, 1)) && !isListMarker(first);
        if (!continues) {
            if (wordsIn(current, true).length) sentences.push(current);
            current = '';
        }
    });
    return sentences;
}

/**
 * Words, sentences (with their word counts) and paragraphs (with word and sentence counts) of `text`.
 * @param {string} text - plain text; paragraphs separated by line breaks
 * @returns {{
 *   words: number,
 *   sentences: Array<{ text: string, words: number }>,
 *   paragraphs: Array<{ text: string, words: number, sentences: number }>
 * }}
 */
export function countText(text) {
    const paragraphs = splitParagraphs(text).map((p) => ({
        text: p,
        words: wordsIn(p, true).length,
        sentences: splitSentences(p).length
    }));
    const sentences = splitSentences(text).map((s) => ({ text: s, words: wordsIn(s, true).length }));
    return {
        words: paragraphs.reduce((n, p) => n + p.words, 0),
        sentences,
        paragraphs
    };
}

/**
 * `text` cut after `maxWords` words; punctuation between the words stays and does not count.
 * @param {string} text
 * @param {number} maxWords
 */
export function truncateWords(text, maxWords) {
    const out = [];
    let seen = 0;
    for (const token of String(text || '').split(/\s+/).filter(Boolean)) {
        if (isWord(token)) {
            if (seen === maxWords) break;
            seen += 1;
        }
        out.push(token);
    }
    while (out.length && !isWord(out[out.length - 1])) out.pop();
    return out.join(' ');
}
