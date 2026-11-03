// The three B1 lexicons (about 273 kB, derived from the OpenTaal word list) are no longer part of the bundle.
// `b1LexiconLoader.js` fetches them from the published assets on the first use of the Direct Duidelijk tab and hands them to
// `setB1Lexicons`; until then the lists are empty and `b1LexiconsLoaded()` is false.
import { mergeB1Guidelines, getB1MetricStatus } from './b1Guidelines.js';

export const PASSIVE_PATTERNS = [
    /\bwordt\b/gi, /\bworden\b/gi, /\bwerd\b/gi, /\bwerden\b/gi,
    /\bis\s+\w+d\b/gi, /\bzijn\s+\w+d\b/gi,
    /\ber\s+wordt\b/gi, /\bdiende\s+te\b/gi,
    /\bdient\s+te\b/gi, /\bmoet\s+worden\b/gi
];

/** @type {string[]} — derived from OpenTaal via `scripts/build-b1-lexicons.mjs` (see `b1-lexicon-ATTRIBUTION.txt`). */
export let FORMAL_WORDS = [];

export const INCLUSIVE_ISSUES = [
    'hij of zij', 'hij/zij', 'mannen en vrouwen', 'dames en heren'
];

/** Heavy/legal / policy compounds — proxy for jargon density. */
export let JARGON_PROXY_WORDS = [];

/** Cohesion / discourse markers (indicative). */
export let COHESION_SIGNAL_WORDS = [];

let lexiconsLoaded = false;

/** True once `setB1Lexicons` has run: `calculateB1ParameterSnapshot` gives metric values only then. */
export function b1LexiconsLoaded() {
    return lexiconsLoaded;
}

/**
 * Installs the three lexicons (string arrays).
 * @param {{ jargon: string[], formal: string[], cohesion: string[] }} lexicons
 */
export function setB1Lexicons({ jargon, formal, cohesion }) {
    JARGON_PROXY_WORDS = jargon;
    FORMAL_WORDS = formal;
    COHESION_SIGNAL_WORDS = cohesion;
    lexiconsLoaded = true;
}

/** Minimum letter count (a-z/A-Z/unicode letters) to count as a “long word” proxy. */
export const B1_LONG_WORD_MIN_LETTERS = 10;

/** Escapes a string for safe use inside a `RegExp` constructor. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip outer punctuation so lexicon singles match tokens like `derhalve.` */
function lexiconTokenKey(token) {
    return token
        .replace(/^[^a-zA-ZÀ-ÿ]+/gi, '')
        .replace(/[^a-zA-ZÀ-ÿ]+$/gi, '')
        .toLowerCase();
}

/**
 * @param {string} lowerText — full chapter lowercased, spaces normalized
 * @param {string[]} terms — lexicon entries (singles and phrases)
 * @returns {number}
 */
function countLexiconHits(lowerText, terms) {
    const singles = new Set();
    const phrases = [];
    for (const raw of terms) {
        const t = String(raw).trim().toLowerCase();
        if (!t) continue;
        if (/\s/.test(t)) {
            phrases.push(t);
        } else {
            singles.add(t);
        }
    }

    let hits = 0;
    const wordTokens = lowerText.split(/\s+/).filter((w) => w.length > 0);
    for (const w of wordTokens) {
        const key = lexiconTokenKey(w);
        if (key && singles.has(key)) hits += 1;
    }

    for (const ph of phrases) {
        const pattern = `\\b${escapeRegExp(ph).replace(/\s+/g, '\\s+')}\\b`;
        const re = new RegExp(pattern, 'gi');
        const m = lowerText.match(re);
        if (m) hits += m.length;
    }

    return hits;
}

/**
 * Strips HTML but keeps paragraph breaks (`\n`) where sensible.
 * @param {string} raw
 * @returns {string} lines separated by `\n`, no empty lines
 */
export function stripHtmlPreservingParagraphs(raw) {
    let s = String(raw).replace(/\u00a0/g, ' ');
    if (s.includes('<')) {
        s = s
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<\/h[1-6]>/gi, '\n')
            .replace(/<\/blockquote>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');
    }
    return s
        .split(/\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .trim();
}

/**
 * B1 parameter snapshot for the active chapter (client-side proxies, not a Textmetrics clone).
 * @param {string} text - plain text and/or HTML; paragraphs via `\n` or block tags
 * @returns {null|{
 *   avgWordsPerSentence: number,
 *   passiveSentencePercent: number,
 *   jargonProxyHits: number,
 *   jargonProxyPer1000: number,
 *   formalWordHits: number,
 *   formalWordPer1000: number,
 *   longWordHits: number,
 *   longWordPer1000: number,
 *   paragraphCount: number,
 *   avgWordsPerParagraph: number,
 *   cohesionSignalHits: number,
 *   wordCount: number,
 *   sentenceCount: number,
 *   activeVoicePercent: number,
 *   heldereZinnenScore: number,
 *   avgSentencesPerParagraph: number, // sum of '.' per newline chunk (after stripping leading 'N. ') ÷ paragraph count; oversplit cap when chunk count exceeds total periods
 * }}
 */
export function calculateB1ParameterSnapshot(text) {
    if (!text || String(text).trim().length < 3) return null;

    const withBreaks = stripHtmlPreservingParagraphs(text);
    if (!withBreaks) return null;

    const paragraphs = withBreaks.split(/\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    const paragraphCount = Math.max(paragraphs.length, 1);

    const singleSpaceText = paragraphs.join(' ');
    const words = singleSpaceText.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    if (wordCount < 1) return null;

    const sentenceParts = singleSpaceText
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2);
    const sentenceCountForAvg = Math.max(sentenceParts.length, 1);
    const avgWordsPerSentence = Math.round(wordCount / sentenceCountForAvg);

    let passiveSentenceCount = 0;
    for (const sent of sentenceParts) {
        if (
            PASSIVE_PATTERNS.some((re) => {
                re.lastIndex = 0;
                return re.test(sent);
            })
        ) {
            passiveSentenceCount += 1;
        }
    }
    const passiveSentencePercent =
        sentenceParts.length > 0
            ? Math.round((100 * passiveSentenceCount) / sentenceParts.length)
            : 0;

    const lower = singleSpaceText.toLowerCase();

    const jargonProxyHits = countLexiconHits(lower, JARGON_PROXY_WORDS);
    const jargonProxyPer1000 = Math.round((1000 * jargonProxyHits) / Math.max(wordCount, 1));

    const formalWordHits = countLexiconHits(lower, FORMAL_WORDS);
    const formalWordPer1000 = Math.round((1000 * formalWordHits) / Math.max(wordCount, 1));

    let longWordHits = 0;
    for (const w of words) {
        const letters = w.replace(/[^a-zA-ZÀ-ÿ]/g, '');
        if (letters.length >= B1_LONG_WORD_MIN_LETTERS) longWordHits += 1;
    }
    const longWordPer1000 = Math.round((1000 * longWordHits) / Math.max(wordCount, 1));

    const avgWordsPerParagraph = Math.round(wordCount / paragraphCount);

    const cohesionSignalHits = countLexiconHits(lower, COHESION_SIGNAL_WORDS);

    const sentenceCount = sentenceParts.length;
    const activeVoicePercent =
        sentenceCount > 0 ? Math.max(0, Math.min(100, 100 - passiveSentencePercent)) : 100;

    const g = mergeB1Guidelines(null);
    const m = g.metrics;
    const statusToScore = (st) => (st === 'good' ? 100 : st === 'warn' ? 50 : 0);
    const sj = statusToScore(getB1MetricStatus('jargonProxyPer1000', jargonProxyPer1000, m.jargonProxyPer1000));
    const sf = statusToScore(getB1MetricStatus('formalWordPer1000', formalWordPer1000, m.formalWordPer1000));
    const sl = statusToScore(getB1MetricStatus('longWordPer1000', longWordPer1000, m.longWordPer1000));
    const heldereZinnenScore = Math.round((sj + sf + sl) / 3);

    // "Gem. zinnen/alinea": naive period count per newline-separated chunk (user-entered alinea),
    // minus leading list marker "N. " so "1. Zin een. Zin twee." counts as 2 dots.
    let totalPeriods = 0;
    for (const p of paragraphs) {
        const withoutEnum = p.replace(/^\s*\d+\.\s*/, '');
        const n = (withoutEnum.match(/\./g) || []).length;
        totalPeriods += n;
    }
    const paragraphCountForSentencesPerPara =
        paragraphCount > totalPeriods && totalPeriods > 0 ? 1 : paragraphCount;
    const avgSentencesPerParagraph =
        paragraphCountForSentencesPerPara > 0
            ? Math.round((totalPeriods / paragraphCountForSentencesPerPara) * 10) / 10
            : 0;

    return {
        avgWordsPerSentence,
        passiveSentencePercent,
        jargonProxyHits,
        jargonProxyPer1000,
        formalWordHits,
        formalWordPer1000,
        longWordHits,
        longWordPer1000,
        paragraphCount,
        avgWordsPerParagraph,
        cohesionSignalHits,
        wordCount,
        sentenceCount,
        activeVoicePercent,
        heldereZinnenScore,
        avgSentencesPerParagraph
    };
}

/**
 * Legacy readability/formality/inclusivity metrics and mock spelling hints from HTML/text.
 * @param {string} text
 * @returns {{readability: number, formality: number, inclusivity: number, wordCount: number, sentenceCount: number, spellingErrors: Array<{wrong: string, correct: string}>}|null}
 */
export const calculateMetrics = (text) => {
    if (!text || text.trim().length < 3) return null;

    // Remove HTML tags for metric calculation
    const cleanText = text.replace(/<[^>]*>/g, ' ');
    
    const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim().length > 2);
    const words = cleanText.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    if (wordCount < 1) return null;

    // 1. Readability
    const avgSentLen = sentences.length > 0 ? wordCount / sentences.length : wordCount;
    const longWords = words.filter(w => w.replace(/[^a-zA-ZÀ-ÿ]/g, '').length > 8).length;
    const longWordRatio = longWords / Math.max(wordCount, 1);
    const readabilityRaw = Math.max(0, 100 - (avgSentLen - 12) * 3 - longWordRatio * 60);
    const readability = Math.round(Math.min(100, Math.max(0, readabilityRaw)));

    // 2. Tone (Formality)
    let passiveCount = 0;
    PASSIVE_PATTERNS.forEach(p => { const m = cleanText.match(p); if (m) passiveCount += m.length; });
    const formalCount = FORMAL_WORDS.filter(fw => cleanText.toLowerCase().includes(fw.toLowerCase())).length;
    const formality = Math.round(Math.min(100, (passiveCount / Math.max(sentences.length, 1)) * 80 + formalCount * 10));

    // 3. Inclusivity
    const issueCount = INCLUSIVE_ISSUES.filter(p => cleanText.toLowerCase().includes(p.toLowerCase())).length;
    const inclusivity = Math.max(0, 100 - issueCount * 30);

    // 4. Spelling Errors (Mocked/Simple dictionary)
    const COMMON_MISSPELLINGS = {
        'onodig': 'onnodig',
        'midellijk': 'middellijk',
        'ten alle tijden': 'te allen tijde',
        'nogtans': 'nochtans',
        'bij dezen': 'bij deze'
    };

    let spellingErrors = [];
    Object.keys(COMMON_MISSPELLINGS).forEach(wrong => {
        const correct = COMMON_MISSPELLINGS[wrong];
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        if (regex.test(cleanText)) {
            spellingErrors.push({ wrong, correct });
        }
    });

    return { 
        readability, 
        formality, 
        inclusivity, 
        wordCount, 
        sentenceCount: sentences.length, 
        spellingErrors 
    };
};

/** Upper bound of highlight ranges painted in one pass. */
const MAX_HIGHLIGHT_RANGES = 5000;

/**
 * Uses the CSS Custom Highlight API to underline suggestion spans in `element` (best-effort).
 * @param {HTMLElement|null} element - Root to scan for text matches
 * @param {Array<{original: string}>|null|undefined} suggestions
 */
export const applyRealtimeHighlights = (element, suggestions) => {
    if (typeof window === 'undefined' || !window.CSS || !CSS.highlights) return;

    try {
        CSS.highlights.delete('sa-ai-suggestions');
        if (!suggestions || suggestions.length === 0 || !element) return;

        const ranges = [];
        const textNodes = [];

        // Find all text nodes
        const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        let n;
        while (n = walk.nextNode()) {
            textNodes.push(n);
        }

        suggestions.forEach(sug => {
            //: the trigger word is literal text, so it is escaped before it becomes a RegExp
            // (the original used it as a pattern: `a*`, `(a+)+$` or an empty entry froze the whole Open WebUI tab). Empty and
            // non-string values are skipped, a zero-length match cannot loop, and the number of ranges is capped.
            if (typeof sug.original !== 'string' || sug.original === '') return;
            const regex = new RegExp(escapeRegExp(sug.original), 'gi');

            textNodes.forEach(node => {
                const text = node.textContent;
                let match;
                while (ranges.length < MAX_HIGHLIGHT_RANGES && (match = regex.exec(text)) !== null) {
                    if (match[0].length === 0) {
                        regex.lastIndex += 1;
                        continue;
                    }
                    const range = new Range();
                    range.setStart(node, match.index);
                    range.setEnd(node, match.index + match[0].length);
                    ranges.push(range);
                }
            });
        });

        if (ranges.length > 0) {
            const highlight = new Highlight(...ranges);
            CSS.highlights.set('sa-ai-suggestions', highlight);
        }
    } catch (e) {
        console.warn('CSS Custom Highlight API not fully supported or failed', e);
    }
};
