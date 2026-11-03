import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateB1ParameterSnapshot,
    stripHtmlPreservingParagraphs,
    B1_LONG_WORD_MIN_LETTERS,
    JARGON_PROXY_WORDS,
    FORMAL_WORDS,
    COHESION_SIGNAL_WORDS,
    b1LexiconsLoaded
} from '../src/lib/utils/analysis.js';
import { ensureB1Lexicons } from '../src/lib/utils/b1LexiconLoader.js';
import { readFileSync } from 'node:fs';
import {
    mergeB1Guidelines,
    getB1MetricStatus,
    getDefaultB1Guidelines,
    getB1GuidelinesAdminExample,
    B1_METRIC_KEYS,
    formFieldsFromMergedGuidelines,
    b1GuidelinesFromFormFields
} from '../src/lib/utils/b1Guidelines.js';
import {
    normalizeB1AlternativesFromItem,
    feedbackToSuggestions,
    localMultiSpaceSuggestions,
    mergeSpellingSuggestionsWithLocalSpaceRules
} from '../src/lib/utils/suggestions.js';

// the lexicons are loaded on first use of the Direct Duidelijk tab; the tests load them from the source files.
test('B1 lexicons: empty until loaded; a failed load rejects and is retried; a successful load is shared', async () => {
    assert.equal(b1LexiconsLoaded(), false);
    assert.equal(JARGON_PROXY_WORDS.length, 0);
    await assert.rejects(ensureB1Lexicons({ fetchJson: async () => { throw new Error('offline'); } }), /offline/);
    assert.equal(b1LexiconsLoaded(), false, 'a failed load installs nothing');
    let calls = 0;
    const fetchJson = async (kind) => { calls += 1; return JSON.parse(readFileSync(new URL(`../src/lib/data/b1-lexicon-${kind}.json`, import.meta.url), 'utf8')); };
    await Promise.all([ensureB1Lexicons({ fetchJson }), ensureB1Lexicons({ fetchJson })]);
    await ensureB1Lexicons({ fetchJson });
    assert.equal(calls, 3, 'one load of three files, shared by concurrent and later callers');
    assert.equal(b1LexiconsLoaded(), true);
});

test('calculateB1ParameterSnapshot: null for very short text', () => {
    assert.equal(calculateB1ParameterSnapshot(''), null);
    assert.equal(calculateB1ParameterSnapshot('ab'), null);
});

test('calculateB1ParameterSnapshot: one sentence yields metrics', () => {
    const s = calculateB1ParameterSnapshot('Het huis wordt gebouwd.');
    assert.ok(s);
    assert.equal(s.sentenceCount, 1);
    assert.ok(s.avgWordsPerSentence >= 1);
    assert.ok(typeof s.passiveSentencePercent === 'number');
    assert.ok('longWordPer1000' in s && typeof s.longWordPer1000 === 'number');
});

test('calculateB1ParameterSnapshot: multiple paragraphs from newlines', () => {
    const s = calculateB1ParameterSnapshot('Eerste alinea hier.\n\nTweede alinea verder.');
    assert.ok(s);
    assert.equal(s.paragraphCount, 2);
    assert.ok(s.avgWordsPerParagraph > 0);
});

test('stripHtmlPreservingParagraphs: p and br become breaks', () => {
    const plain = stripHtmlPreservingParagraphs('<p>Eerste.</p><p>Tweede regel.</p>');
    assert.match(plain, /Eerste/);
    assert.match(plain, /Tweede/);
    const lines = plain.split('\n').filter(Boolean);
    assert.ok(lines.length >= 2);
});

test('calculateB1ParameterSnapshot: counts repeated formal phrases', () => {
    const s = calculateB1ParameterSnapshot(
        'Derhalve is het helder. Derhalve ook zo.'
    );
    assert.ok(s);
    assert.ok(s.formalWordHits >= 2);
});

test('B1 lexicon JSON exports: minimum size for jargon, formal, cohesion', () => {
    assert.ok(JARGON_PROXY_WORDS.length >= 1000, 'jargon lexicon');
    assert.ok(FORMAL_WORDS.length >= 1000, 'formal lexicon');
    assert.ok(COHESION_SIGNAL_WORDS.length >= 1000, 'cohesion lexicon');
});

test('calculateB1ParameterSnapshot: DD extra fields present', () => {
    const s = calculateB1ParameterSnapshot('Eerste zin.\n\nTweede zin hier.');
    assert.ok(s);
    assert.ok('activeVoicePercent' in s);
    assert.ok('heldereZinnenScore' in s);
    assert.ok('avgSentencesPerParagraph' in s);
    assert.ok(s.avgSentencesPerParagraph >= 0);
});

test('mergeB1Guidelines: extra DD metric definitions exist', () => {
    const m = mergeB1Guidelines(null);
    assert.ok(m.metrics.activeVoicePercent);
    assert.ok(m.metrics.heldereZinnenScore);
    assert.ok(m.metrics.avgSentencesPerParagraph);
});

test('feedbackToSuggestions: agent_woordenlijst maps Alternatieven', () => {
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'subsidiëren',
                    Categorie: 'niet-B1',
                    Alternatieven: [
                        { Tekst: 'financieel steunen', Uitleg: 'Eenvoudiger.' },
                        { Tekst: 'betalen', Uitleg: 'Concreet.' }
                    ]
                }
            ]
        },
        'block-h1',
        'h1',
        'agent_woordenlijst',
        'We moeten subsidiëren.'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'woordenlijst');
    assert.ok(rows[0].alternatives?.length >= 2);
});

test('calculateB1ParameterSnapshot: Gem. zinnen/alinea = period count per line (oversplit DOM)', () => {
    // Two full stops in the narrative; extra newlines from list/DOM must not average down to 0.5.
    const domOversplit = [
        '1. De 14 agrariërs uit het gebied rondom de Meerkoetentocht te informeren dat de provincie haar mogelijkheden voor financiële ondersteuning',
        'benut.',
        'en geen aanvullende financiering kan bieden.'
    ].join('\n');
    const s = calculateB1ParameterSnapshot(domOversplit);
    assert.ok(s);
    assert.equal(s.paragraphCount, 3);
    assert.equal(s.avgSentencesPerParagraph, 2);
});

test('calculateB1ParameterSnapshot: Gem. zinnen/alinea one line, list numbering', () => {
    const oneLine =
        '1. De 14 agrariërs uit het gebied rondom de Meerkoetentocht te informern dat de provincie haar mogelijkheden voor financiële ondersteuning benut. en geen aanvullende financiering kan bieden.';
    const s = calculateB1ParameterSnapshot(oneLine);
    assert.ok(s);
    assert.equal(s.avgSentencesPerParagraph, 2);
});

test('calculateB1ParameterSnapshot: long-word proxy', () => {
    const long = 'a'.repeat(B1_LONG_WORD_MIN_LETTERS);
    const s = calculateB1ParameterSnapshot(`Kort en ${long} test.`);
    assert.ok(s);
    assert.ok(s.longWordHits >= 1);
});

test('mergeB1Guidelines: null override yields defaults', () => {
    const m = mergeB1Guidelines(null);
    const d = getDefaultB1Guidelines();
    assert.equal(m.metrics.avgWordsPerSentence.good[1], d.metrics.avgWordsPerSentence.good[1]);
    assert.equal(m.presetLabel, d.presetLabel);
});

test('mergeB1Guidelines: org overrides avg words per sentence bands', () => {
    const m = mergeB1Guidelines({
        presetLabel: 'Org',
        metrics: {
            avgWordsPerSentence: {
                good: [0, 30],
                warn: [31, 40],
                target: '≤ 30'
            }
        }
    });
    assert.equal(m.presetLabel, 'Org');
    assert.deepEqual(m.metrics.avgWordsPerSentence.good, [0, 30]);
    assert.deepEqual(m.metrics.avgWordsPerSentence.warn, [31, 40]);
    assert.equal(m.metrics.avgWordsPerSentence.target, '≤ 30');
    assert.ok(m.metrics.passiveSentencePercent.good[1] === 20);
});

test('getB1MetricStatus: uses merged lower bands', () => {
    const m = mergeB1Guidelines({
        metrics: { avgWordsPerSentence: { good: [0, 30], warn: [31, 35], direction: 'lower' } }
    });
    const def = m.metrics.avgWordsPerSentence;
    assert.equal(getB1MetricStatus('avgWordsPerSentence', 28, def), 'good');
    assert.equal(getB1MetricStatus('avgWordsPerSentence', 32, def), 'warn');
    assert.equal(getB1MetricStatus('avgWordsPerSentence', 50, def), 'bad');
});

test('mergeB1Guidelines: globalSources empty array clears inherited globals', () => {
    const base = mergeB1Guidelines({ globalSources: [{ label: 'A' }] });
    assert.equal(base.globalSources.length, 1);
    const cleared = mergeB1Guidelines({ globalSources: [] });
    assert.equal(cleared.globalSources.length, 0);
});

test('mergeB1Guidelines: per-metric sources override when key present', () => {
    const m = mergeB1Guidelines({
        metrics: {
            jargonProxyPer1000: {
                sources: [{ label: 'Bron X', url: 'https://example.org' }]
            }
        }
    });
    assert.equal(m.metrics.jargonProxyPer1000.sources.length, 1);
    assert.equal(m.metrics.jargonProxyPer1000.sources[0].label, 'Bron X');
});

test('getDefaultB1Guidelines: global and per-metric sources present', () => {
    const d = getDefaultB1Guidelines();
    assert.ok(Array.isArray(d.globalSources) && d.globalSources.length >= 1, 'globalSources');
    for (const s of d.globalSources) {
        assert.ok(typeof s.label === 'string' && s.label.trim().length > 0, 'global source label');
    }
    for (const k of B1_METRIC_KEYS) {
        const src = d.metrics[k]?.sources;
        assert.ok(Array.isArray(src) && src.length >= 1, `metrics.${k}.sources`);
        for (const row of src) {
            assert.ok(typeof row.label === 'string' && row.label.trim().length > 0, `${k} source label`);
        }
    }
});

test('getB1GuidelinesAdminExample: all metric keys and Infinity cohesion upper bound', () => {
    const ex = getB1GuidelinesAdminExample();
    for (const k of B1_METRIC_KEYS) {
        assert.ok(ex.metrics[k], `missing metric ${k}`);
    }
    const m = mergeB1Guidelines(ex);
    assert.equal(m.metrics.cohesionSignalHits.good[1], Infinity);
    assert.equal(m.metrics.avgWordsPerSentence.good[1], 18);
});

test('b1Guidelines form roundtrip preserves cohesion Infinity', () => {
    const merged0 = mergeB1Guidelines(null);
    const form = formFieldsFromMergedGuidelines(merged0);
    form.metrics.cohesionSignalHits.goodHi = '';
    const payload = b1GuidelinesFromFormFields(form);
    const merged1 = mergeB1Guidelines(payload);
    assert.equal(merged1.metrics.cohesionSignalHits.good[1], Infinity);
});

test('b1GuidelinesFromFormFields: invalid number throws', () => {
    const form = formFieldsFromMergedGuidelines(mergeB1Guidelines(null));
    form.metrics.avgWordsPerSentence.goodLo = 'x';
    assert.throws(() => b1GuidelinesFromFormFields(form), /Goed \(van\)/);
});

test('normalizeB1AlternativesFromItem: Herschrijvingen preferred', () => {
    const alts = normalizeB1AlternativesFromItem({
        Origineel: 'foo',
        Herschrijvingen: [
            { Tekst: 'a', Uitleg: 'waarom a' },
            { Tekst: 'b', Uitleg: 'waarom b' }
        ]
    });
    assert.equal(alts.length, 2);
    assert.equal(alts[0].tekst, 'a');
    assert.equal(alts[1].uitleg, 'waarom b');
});

test('normalizeB1AlternativesFromItem: legacy Suggestie', () => {
    const alts = normalizeB1AlternativesFromItem({
        Origineel: 'x',
        Suggestie: 'y',
        Uitleg: 'leg'
    });
    assert.deepEqual(alts, [{ tekst: 'y', uitleg: 'leg' }]);
});

test('feedbackToSuggestions: two alternatives on one span', () => {
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'oud',
                    Herschrijvingen: [
                        { Tekst: 'nieuw1', Uitleg: 'u1' },
                        { Tekst: 'nieuw2', Uitleg: 'u2' }
                    ]
                }
            ]
        },
        'block-1',
        'h1',
        'agent_b1',
        'paragraaf met oud erin'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alternatives.length, 2);
    assert.equal(rows[0].b1AlternativesIncomplete, undefined);
});

test('feedbackToSuggestions: flags incomplete when one rewrite', () => {
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'oud',
                    Herschrijvingen: [{ Tekst: 'nieuw1', Uitleg: 'u1' }]
                }
            ]
        },
        'block-1',
        'h1',
        'agent_b1',
        'tekst met oud'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].b1AlternativesIncomplete, true);
});

test('feedbackToSuggestions: taalreview (agent_spelling_grammatica) maps Uitleg and canAccept', () => {
    const plain = 'Dit is een fout zin.';
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'fout zin',
                    Suggestie: 'foute zin',
                    Uitleg: 'Na onbepaald lidwoord hoort een bijvoeglijk naamwoord.'
                }
            ]
        },
        'block-h1',
        'h1',
        'agent_spelling_grammatica',
        plain,
        'spelling',
        `<p>${plain}</p>`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'spelling');
    assert.match(rows[0].id, /^spelling-h1-block-h1-0$/);
    assert.equal(rows[0].canAccept, true);
    assert.match(rows[0].explanation, /lidwoord/);
});

test('feedbackToSuggestions: taalreview canAccept false when fragment not in plain text', () => {
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'ontbreekt',
                    Suggestie: 'fix',
                    Uitleg: 'reden'
                }
            ]
        },
        'block-h1',
        'h1',
        'agent_spelling_grammatica',
        'andere tekst',
        'spelling',
        'andere tekst'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canAccept, false);
});

test('localMultiSpaceSuggestions: flags consecutive spaces', () => {
    const html = '<p>Dit  heeft   drie</p>';
    const rows = localMultiSpaceSuggestions(html, 'block-1', 'h1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].original, '  ');
    assert.equal(rows[0].suggested, ' ');
    assert.equal(rows[1].original, '   ');
});

test('localMultiSpaceSuggestions: flags space before period', () => {
    const html = '<p>hallo .</p>';
    const rows = localMultiSpaceSuggestions(html, 'block-1', 'h1');
    assert.ok(rows.some((r) => r.original === ' .' && r.suggested === '.'));
});

test('localMultiSpaceSuggestions: one fix for double space before period', () => {
    const html = '<p>hallo  .</p>';
    const rows = localMultiSpaceSuggestions(html, 'block-1', 'h1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].original, '  .');
    assert.equal(rows[0].suggested, '.');
});

test('feedbackToSuggestions: decodes &nbsp; entities in taalreview Origineel', () => {
    const html = '<p>hello&nbsp;&nbsp;there</p>';
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'hello&nbsp;&nbsp;there',
                    Suggestie: 'hello there',
                    Uitleg: 'Geen dubbele spatie nodig.'
                }
            ]
        },
        'block-1',
        'h1',
        'agent_spelling_grammatica',
        '',
        'spelling',
        html
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].original, 'hello  there');
    assert.equal(rows[0].suggested, 'hello there');
    assert.equal(rows[0].canAccept, true);
    assert.equal(rows[0].original.includes('&'), false);
});

test('mergeSpellingSuggestionsWithLocalSpaceRules: dedupes when agent already covers spaces', () => {
    const html = '<p>a  b</p>';
    const agent = feedbackToSuggestions(
        {
            Suggesties: [{ Origineel: 'a  b', Suggestie: 'a b', Uitleg: 'spaties' }]
        },
        'block-1',
        'h1',
        'agent_spelling_grammatica',
        'a b',
        'spelling',
        html
    );
    const merged = mergeSpellingSuggestionsWithLocalSpaceRules(html, 'block-1', 'h1', agent);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].original, 'a  b');
});

test('feedbackToSuggestions: taalreview canAccept true when only whitespace differs from editor plain', () => {
    const plainFromEditor = 'Dit is een fout zin.';
    const preserved = 'Dit  is  een fout zin';
    const rows = feedbackToSuggestions(
        {
            Suggesties: [
                {
                    Origineel: 'Dit  is  een fout zin',
                    Suggestie: 'Dit is een foute zin',
                    Uitleg: 'Interpunctie/spaties en woordvorm.'
                }
            ]
        },
        'block-h1',
        'h1',
        'agent_spelling_grammatica',
        plainFromEditor,
        'spelling',
        preserved
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canAccept, true);
});
