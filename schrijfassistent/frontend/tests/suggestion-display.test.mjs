import test from 'node:test';
import assert from 'node:assert/strict';
import {
    localMultiSpaceSuggestions,
    suggestionDisplayText
} from '../src/lib/utils/suggestions.js';

test('whitespace-only collapsed preview displays the reason without changing the suggestion', () => {
    const [row] = localMultiSpaceSuggestions('<p>Een  voorbeeld.</p>', 'block-h1', 'h1');
    const before = structuredClone(row);
    assert.equal(suggestionDisplayText(row.original, row.explanation), 'Gebruik een enkele spatie.');
    assert.deepEqual(row, before);
});

test('empty text, tabs, newlines and non-breaking spaces display the reason', () => {
    for (const text of ['', ' ', '\t', '\n', '\u00a0']) {
        assert.equal(suggestionDisplayText(text, 'Verwijder overtollige witruimte.'), 'Verwijder overtollige witruimte.');
    }
    assert.equal(suggestionDisplayText(' ', ''), '—');
    assert.equal(suggestionDisplayText('', '  '), '—');
});

test('visible preview text remains unchanged, including punctuation and surrounding spaces', () => {
    for (const text of ['voorbeeld', '.', ' .', ' tekst ']) {
        assert.equal(suggestionDisplayText(text, 'Reden'), text);
    }
});
