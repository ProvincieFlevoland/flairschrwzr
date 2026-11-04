import test from 'node:test';
import assert from 'node:assert/strict';
import {
    localMultiSpaceSuggestions,
    suggestionDisplayText
} from '../src/lib/utils/suggestions.js';

test('whitespace-only sidebar text displays the reason without changing the replacement', () => {
    const [row] = localMultiSpaceSuggestions('<p>Een  voorbeeld.</p>', 'block-h1', 'h1');
    assert.equal(suggestionDisplayText(row.original, row.explanation), 'Gebruik een enkele spatie.');
    assert.equal(suggestionDisplayText(row.suggested, row.explanation), 'Gebruik een enkele spatie.');
    assert.equal(row.original, '  ');
    assert.equal(row.suggested, ' ');
    assert.equal(row.canAccept, true);
});

test('empty text, tabs, newlines and non-breaking spaces display the reason', () => {
    for (const text of ['', ' ', '\t', '\n', '\u00a0']) {
        assert.equal(suggestionDisplayText(text, 'Verwijder overtollige witruimte.'), 'Verwijder overtollige witruimte.');
    }
    assert.equal(suggestionDisplayText(' ', ''), '—');
    assert.equal(suggestionDisplayText('', '  '), '—');
});

test('visible text remains unchanged, including punctuation and surrounding spaces', () => {
    for (const text of ['voorbeeld', '.', ' .', ' tekst ']) {
        assert.equal(suggestionDisplayText(text, 'Reden'), text);
    }
});
