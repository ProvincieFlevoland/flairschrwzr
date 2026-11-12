import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countText, countWords, splitSentences, truncateWords } from '../src/lib/utils/textCount.js';
import { stripBlockPlainWithBreaks } from '../src/lib/utils/blockPlainText.js';
import { calculateB1ParameterSnapshot, calculateMetrics } from '../src/lib/utils/analysis.js';

// Same cases as backend/tests/test_text_count.py, so backend and frontend count the same way.
const { cases } = JSON.parse(
    readFileSync(new URL('../../dev/fixtures/text-count-cases.json', import.meta.url), 'utf8')
);

test('textCount: shared cases with the backend', () => {
    for (const c of cases) {
        const counted = countText(c.text);
        assert.equal(counted.words, c.words, `${c.name}: words`);
        assert.deepEqual(counted.sentences.map((s) => s.words), c.sentences, `${c.name}: sentences`);
        assert.equal(counted.paragraphs.length, c.paragraphs, `${c.name}: paragraphs`);
        assert.equal(countWords(c.text), c.words, `${c.name}: countWords`);
    }
});

test('textCount: punctuation does not change the word count', () => {
    const plain = countWords('Aanbesteding bouw parkeergarage provinciehuis');
    for (const variant of [
        'Aanbesteding bouw parkeergarage provinciehuis.',
        'Aanbesteding – bouw parkeergarage, provinciehuis!',
        '“Aanbesteding bouw parkeergarage provinciehuis”',
        'Aanbesteding bouw parkeergarage provinciehuis …'
    ]) {
        assert.equal(countWords(variant), plain, variant);
    }
});

test('textCount: abbreviations do not end a sentence', () => {
    assert.deepEqual(splitSentences('Zie o.a. art. 3, bijv. lid 2. Daarna volgt meer.'), [
        'Zie o.a. art. 3, bijv. lid 2.',
        'Daarna volgt meer.'
    ]);
});

test('textCount: truncateWords skips punctuation', () => {
    assert.equal(truncateWords('Subsidie – toekenning 4-5 mei comité Flevoland 2024', 5), 'Subsidie – toekenning 4-5 mei comité');
    assert.equal(truncateWords('Een twee – drie', 2), 'Een twee');
});

test('stripBlockPlainWithBreaks: one line per paragraph or <br>', () => {
    assert.equal(
        stripBlockPlainWithBreaks('<p>Eerste&nbsp;alinea.</p><p>Tweede <b>alinea</b>,<br>met een regel.</p>'),
        'Eerste alinea.\nTweede alinea ,\nmet een regel.'
    );
    assert.equal(countText(stripBlockPlainWithBreaks('<p>Een.</p><p>Twee.</p><p></p>')).paragraphs.length, 2);
});

test('B1 snapshot: loose punctuation and list markers are not words', () => {
    const s = calculateB1ParameterSnapshot('1. Het college – zie bijlage – besluit vandaag.');
    assert.ok(s);
    assert.equal(s.wordCount, 6);
    assert.equal(s.sentenceCount, 1);
    assert.equal(s.avgWordsPerSentence, 6);
});

test('B1 snapshot: abbreviations do not split a sentence', () => {
    const s = calculateB1ParameterSnapshot('De provincie betaalt o.a. de bouw, bijv. van de garage. Dat kost geld.');
    assert.ok(s);
    assert.equal(s.sentenceCount, 2);
    assert.equal(s.wordCount, 14);
    assert.equal(s.avgWordsPerSentence, 7);
});

test('B1 snapshot: words per paragraph use the same count', () => {
    const s = calculateB1ParameterSnapshot('Eerste alinea – kort.\nTweede alinea, ook kort.');
    assert.ok(s);
    assert.equal(s.paragraphCount, 2);
    assert.equal(s.wordCount, 7);
    assert.equal(s.avgWordsPerParagraph, 4);
});

test('calculateMetrics: same word and sentence count', () => {
    const m = calculateMetrics('<p>Dit is o.a. een test – echt.</p><p>Tweede zin.</p>');
    assert.ok(m);
    assert.equal(m.wordCount, 8);
    assert.equal(m.sentenceCount, 2);
});
