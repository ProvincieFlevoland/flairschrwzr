import { decodeHtmlSpaceEntities, stripBlockPlainForTaalreview } from './blockPlainText.js';

/** Max characters for B1 Origineel — longer spans are skipped (forces granular model output). */
export const B1_MAX_ORIGINAL_CHARS = 200;

/**
 * Display-only fallback: keep whitespace replacements intact when applying a suggestion.
 * @param {string} text
 * @param {string} explanation
 * @returns {string}
 */
export function suggestionDisplayText(text, explanation) {
    return text?.trim() ? text : explanation?.trim() || '—';
}

/** Collapses whitespace and nbsp for substring matching (aligned with stripBlockPlain after HTML strip). */
function collapsePlainWhitespace(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Lokale typografie: spaties vóór leestekens + dubbele witruimte (na tag-strip), zonder overlap.
 * @param {string} htmlBlock
 * @param {string} blockId
 * @param {string} chapterId
 * @param {string} [idPrefix]
 * @param {Array<{original?: string}>} [agentRows] — geen dubbele melding als een agent-Origineel deze reeks al bevat.
 * @returns {Array<{id: string, original: string, suggested: string, explanation: string, source: 'spelling', ruleDetails: [], canAccept: boolean}>}
 */
export function localMultiSpaceSuggestions(
    htmlBlock,
    blockId,
    chapterId,
    idPrefix = 'spelling',
    agentRows = []
) {
    const plain = stripBlockPlainForTaalreview(htmlBlock || '');
    if (!plain) return [];

    const rows = [];
    const usedRanges = [];
    const punctuationRegex = / +[.,;:!?]/g;
    const multiSpaceRegex = / {2,}/g;
    const hasAgentCoverage = (snippet) =>
        agentRows.some((r) => {
            const value = String(r?.original || '');
            return value.includes(snippet) || snippet.includes(value);
        });

    const overlaps = (start, end) => usedRanges.some((r) => start < r.end && end > r.start);

    // Prefer punctuation fixes first so "  ." becomes a single actionable fix.
    for (const match of plain.matchAll(punctuationRegex)) {
        const original = match[0];
        const start = match.index ?? -1;
        const end = start + original.length;
        if (start < 0 || overlaps(start, end) || hasAgentCoverage(original)) continue;
        rows.push({
            id: `${idPrefix}-${chapterId}-${blockId}-local-${rows.length}`,
            original,
            suggested: original.slice(-1),
            explanation: 'Verwijder spatie voor leesteken.',
            source: 'spelling',
            ruleDetails: [],
            canAccept: true
        });
        usedRanges.push({ start, end });
    }

    for (const match of plain.matchAll(multiSpaceRegex)) {
        const original = match[0];
        const start = match.index ?? -1;
        const end = start + original.length;
        if (start < 0 || overlaps(start, end) || hasAgentCoverage(original)) continue;
        rows.push({
            id: `${idPrefix}-${chapterId}-${blockId}-local-${rows.length}`,
            original,
            suggested: ' ',
            explanation: 'Gebruik een enkele spatie.',
            source: 'spelling',
            ruleDetails: [],
            canAccept: true
        });
        usedRanges.push({ start, end });
    }

    return rows;
}

/**
 * Agent-taalreview (JSON) + lokale spatiekolommen; alleen rijen met canAccept voor agent.
 * @param {string} htmlBlock
 * @param {string} blockId
 * @param {string} chapterId
 * @param {Array<{original?: string, suggested?: string, explanation?: string, source?: string, canAccept?: boolean, id?: string, ruleDetails?: []}>} agentSpellingRows
 * @param {string} [idPrefix]
 */
export function mergeSpellingSuggestionsWithLocalSpaceRules(
    htmlBlock,
    blockId,
    chapterId,
    agentSpellingRows,
    idPrefix = 'spelling'
) {
    const fromAgent = agentSpellingRows.filter((s) => s.canAccept !== false);
    const local = localMultiSpaceSuggestions(htmlBlock, blockId, chapterId, idPrefix, fromAgent);
    return [...fromAgent, ...local];
}

/**
 * Normalises B1 items: prefer `Herschrijvingen[{Tekst,Uitleg}]`, fallback legacy `Suggestie`+`Uitleg`.
 * @param {object} item - one element from Suggesties[]
 * @returns {Array<{ tekst: string, uitleg: string }>}
 */
export function normalizeB1AlternativesFromItem(item) {
    if (!item || typeof item !== 'object') return [];

    const hr = item.Herschrijvingen ?? item.herschrijvingen;
    if (Array.isArray(hr) && hr.length > 0) {
        const out = [];
        for (const h of hr) {
            if (!h || typeof h !== 'object') continue;
            const tekst = String(h.Tekst ?? h.tekst ?? '').trim();
            const uitleg = String(h.Uitleg ?? h.uitleg ?? h.verbetering ?? '').trim();
            if (!tekst) continue;
            out.push({ tekst, uitleg });
        }
        return out;
    }

    const suggested = String(item.Suggestie ?? item.suggestie ?? '').trim();
    const uitleg = String(item.Uitleg ?? item.verbetering ?? item.explanation ?? '').trim();
    if (!suggested) return [];
    return [{ tekst: suggested, uitleg }];
}

/**
 * Normaliseert Woordenlijst-items: `Alternatieven[{Tekst,Uitleg}]`.
 * @param {object} item - one element from Suggesties[]
 * @returns {Array<{ tekst: string, uitleg: string }>}
 */
export function normalizeWoordenlijstAlternativesFromItem(item) {
    if (!item || typeof item !== 'object') return [];

    const alts = item.Alternatieven ?? item.alternatieven;
    if (!Array.isArray(alts) || alts.length === 0) return [];
    const out = [];
    for (const h of alts) {
        if (!h || typeof h !== 'object') continue;
        const tekst = String(h.Tekst ?? h.tekst ?? '').trim();
        const uitleg = String(h.Uitleg ?? h.uitleg ?? '').trim();
        if (!tekst) continue;
        out.push({ tekst, uitleg });
    }
    return out;
}

/**
 * Parse stored agent feedback (string or object) to a plain object, mirroring AuteurPane.parseAiResponse.
 * @param {string|object|null|undefined} text
 * @returns {object|null}
 */
export function parseAgentFeedback(text) {
    if (!text) return null;
    if (typeof text === 'object' && !Array.isArray(text)) return text;
    if (typeof text !== 'string') return { Feedback: String(text) };

    const trimmed = text.trim();
    let jsonStr = trimmed;
    const match = trimmed.match(/```json\n?([\s\S]*?)\n?```/);
    if (match) {
        jsonStr = match[1].trim();
    } else if (trimmed.includes('{')) {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
        }
    }

    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.ai_response && typeof parsed.ai_response === 'object') return parsed.ai_response;
        if (parsed.feedback && typeof parsed.feedback === 'object') return parsed.feedback;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * @param {object|null} parsedFeedback
 * @param {string} blockId
 * @param {string} chapterId - guideline id (e.g. h1)
 * @param {'agent_b1'|'agent_structuur'|'agent_spelling_grammatica'|'agent_woordenlijst'} assignment
 * @param {string} blockPlainText - HTML-stripped block body for B1 / taalreview guards
 * @param {string} [idPrefix] - stable prefix for ids (default assignment)
 * @param {string|null} [blockHtmlForSpelling] - block HTML (of taal-plain met behouden spaties); voor spelling `includes`-check op dubbele spaties enz.
 * @returns {Array<{id: string, original: string, suggested: string, explanation: string, source: 'b1'|'structuur'|'spelling'|'woordenlijst', wordCategory?: string, alternatives?: Array<{tekst: string, uitleg: string}>, b1AlternativesIncomplete?: boolean, canAccept?: boolean}>}
 */
export function feedbackToSuggestions(
    parsedFeedback,
    blockId,
    chapterId,
    assignment,
    blockPlainText = '',
    idPrefix = assignment,
    blockHtmlForSpelling = null
) {
    if (!parsedFeedback || typeof parsedFeedback !== 'object' || parsedFeedback.FOUT) return [];

    const source =
        assignment === 'agent_b1'
            ? 'b1'
            : assignment === 'agent_spelling_grammatica'
              ? 'spelling'
              : assignment === 'agent_woordenlijst'
                ? 'woordenlijst'
                : 'structuur';
    const blockNorm = collapsePlainWhitespace(blockPlainText);
    const spellingMatchPlain =
        assignment === 'agent_spelling_grammatica' &&
        blockHtmlForSpelling != null &&
        String(blockHtmlForSpelling).length > 0
            ? stripBlockPlainForTaalreview(blockHtmlForSpelling)
            : blockNorm;
    const out = [];

    const arrayBranch =
        parsedFeedback.Suggesties && Array.isArray(parsedFeedback.Suggesties)
            ? parsedFeedback.Suggesties
            : null;

    if (arrayBranch) {
        arrayBranch.forEach((s, idx) => {
            // A null or non-object item would throw a TypeError here,
            // and because the raw answer is stored with the nota the error returned on every open of it. The item is skipped.
            if (!s || typeof s !== 'object') return;
            const oRaw = decodeHtmlSpaceEntities(String(s.Origineel || s.Original || ''));
            const sRaw = decodeHtmlSpaceEntities(String(s.Suggestie || s.suggestie || ''));
            /** @type {string} */
            let original = assignment === 'agent_spelling_grammatica' ? oRaw : oRaw.trim();

            let suggested;
            let explanation;
            /** @type {Array<{tekst: string, uitleg: string}>|undefined} */
            let alternatives;
            let b1AlternativesIncomplete = false;

            if (assignment === 'agent_b1') {
                alternatives = normalizeB1AlternativesFromItem(s);
                if (alternatives.length === 0) return;
                suggested = alternatives[0].tekst;
                explanation = alternatives[0].uitleg || '';
            } else if (assignment === 'agent_woordenlijst') {
                alternatives = normalizeWoordenlijstAlternativesFromItem(s);
                if (alternatives.length === 0) return;
                suggested = alternatives[0].tekst;
                explanation = alternatives[0].uitleg || '';
            } else {
                suggested = assignment === 'agent_spelling_grammatica' ? sRaw : sRaw.trim();
                explanation = s.Uitleg || s.verbetering || s.explanation || '';
            }

            if (!original || !suggested || original === suggested) {
                return;
            }

            // Validation: only check max length
            if (original.length > B1_MAX_ORIGINAL_CHARS) {
                console.warn(
                    `[${assignment === 'agent_b1' ? 'B1' : assignment === 'agent_woordenlijst' ? 'Woordenlijst' : 'Taalreview'}] Suggestie ${idx} overgeslagen: Origineel te lang (${original.length} > ${B1_MAX_ORIGINAL_CHARS})`
                );
                return;
            }

            if (assignment === 'agent_b1' || assignment === 'agent_woordenlijst') {
                alternatives = alternatives.filter((a) => a.tekst && a.tekst !== original);
                if (alternatives.length === 0) return;
                suggested = alternatives[0].tekst;
                explanation = alternatives[0].uitleg || '';
                b1AlternativesIncomplete = alternatives.length < 2;
                if (assignment === 'agent_woordenlijst') {
                    const cat = String(s.Categorie ?? s.categorie ?? '').trim();
                    if (cat) explanation = explanation ? `${cat}: ${explanation}` : cat;
                }
            }

            const canAcceptRow =
                assignment !== 'agent_spelling_grammatica'
                    ? true
                    : Boolean(
                          original &&
                              (spellingMatchPlain.includes(original) ||
                                  (collapsePlainWhitespace(original) &&
                                      collapsePlainWhitespace(spellingMatchPlain).includes(
                                          collapsePlainWhitespace(original)
                                      )))
                      );

            const row = {
                id: `${idPrefix}-${chapterId}-${blockId}-${idx}`,
                original,
                suggested,
                explanation,
                source,
                ruleDetails: [],
                canAccept: canAcceptRow
            };
            if (assignment === 'agent_woordenlijst') {
                const cat = String(s.Categorie ?? s.categorie ?? '').trim();
                if (cat) row.wordCategory = cat;
            }
            if ((assignment === 'agent_b1' || assignment === 'agent_woordenlijst') && alternatives) {
                row.alternatives = alternatives;
                if (b1AlternativesIncomplete) row.b1AlternativesIncomplete = true;
            }
            out.push(row);
        });
        return out;
    }

    // Legacy single-suggestion
    if (assignment === 'agent_b1' || assignment === 'agent_spelling_grammatica') {
        const fragRaw = decodeHtmlSpaceEntities(
            String(parsedFeedback.Origineel || parsedFeedback.Original || '')
        );
        const sugRaw = decodeHtmlSpaceEntities(
            String(parsedFeedback.Suggestie || parsedFeedback.suggestie || '')
        );
        const fragmentToReplace = assignment === 'agent_spelling_grammatica' ? fragRaw : fragRaw.trim();
        const suggestie = assignment === 'agent_spelling_grammatica' ? sugRaw : sugRaw.trim();
        if (!fragmentToReplace || !suggestie || fragmentToReplace === suggestie) return [];
        if (fragmentToReplace.length > B1_MAX_ORIGINAL_CHARS) {
            console.warn(
                `[${assignment === 'agent_b1' ? 'B1' : 'Taalreview'}] Enkele suggestie overgeslagen: Origineel te lang`
            );
            return [];
        }
        const leg =
            parsedFeedback.Verbetering || parsedFeedback.Uitleg || parsedFeedback.explanation || '';
        const canAcceptSingle =
            assignment !== 'agent_spelling_grammatica'
                ? true
                : Boolean(
                      fragmentToReplace &&
                          (spellingMatchPlain.includes(fragmentToReplace) ||
                              (collapsePlainWhitespace(fragmentToReplace) &&
                                  collapsePlainWhitespace(spellingMatchPlain).includes(
                                      collapsePlainWhitespace(fragmentToReplace)
                                  )))
                  );
        /** @type {Record<string, unknown>} */
        const singleRow = {
            id: `${idPrefix}-${chapterId}-${blockId}-0`,
            original: fragmentToReplace,
            suggested: suggestie,
            explanation: leg,
            source,
            ruleDetails: [],
            canAccept: canAcceptSingle
        };
        if (assignment === 'agent_b1') {
            singleRow.alternatives = [{ tekst: suggestie, uitleg: String(leg).trim() }];
            singleRow.b1AlternativesIncomplete = true;
        }
        return [singleRow];
    }

    // Taalreview verwacht array Suggesties; geen structuur-objectvorm
    if (assignment === 'agent_spelling_grammatica') {
        return [];
    }

    // agent_structuur: { "RegelNaam": "uitleg…", … , "Suggestie": "…" } (no Suggesties array)
    const reservedStructKeys = new Set([
        'Suggestie',
        'suggestie',
        'Suggesties',
        'FOUT',
        'RAW',
        'Origineel',
        'Original',
        'Verbetering',
        'explanation',
        'Uitleg',
        'ai_response',
        'feedback'
    ]);

    const rawSuggestie = parsedFeedback.Suggestie ?? parsedFeedback.suggestie;
    const suggestieStr =
        rawSuggestie == null || rawSuggestie === '' ? '' : String(rawSuggestie).trim();
    const fragmentStr = (parsedFeedback.Origineel || parsedFeedback.Original || '').trim();
    let targetText = (fragmentStr || blockNorm || '').trim();

    const ruleDetails = Object.entries(parsedFeedback)
        .filter(([k, v]) => !reservedStructKeys.has(k) && typeof v === 'string' && String(v).trim())
        .map(([key, val]) => ({ key, text: String(val).trim() }));

    const explanationFromRules =
        ruleDetails.length > 0 ? ruleDetails.map(r => r.text).join('\n\n') : '';
    const explanationFallback = (
        parsedFeedback.Verbetering ||
        parsedFeedback.Uitleg ||
        parsedFeedback.explanation ||
        ''
    ).trim();
    const explanation = explanationFromRules || explanationFallback;

    const norm = (s) => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const canAccept = Boolean(
        targetText &&
            suggestieStr &&
            norm(suggestieStr) !== norm(targetText)
    );

    if (!targetText && blockNorm) targetText = blockNorm;
    if (!targetText) {
        if (!ruleDetails.length && !suggestieStr) return [];
        // Nothing to highlight in the cell — still allow sidebar-only feedback
        return [];
    }

    if (!canAccept && !ruleDetails.length) return [];

    return [
        {
            id: `${idPrefix}-${chapterId}-${blockId}-0`,
            original: targetText,
            suggested: suggestieStr,
            explanation,
            source,
            ruleDetails,
            canAccept
        }
    ];
}
