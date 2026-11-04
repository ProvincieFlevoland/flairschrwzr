import test from 'node:test';
import assert from 'node:assert/strict';
import {
    feedbackToSuggestions,
    localMultiSpaceSuggestions,
    mergeSpellingSuggestionsWithLocalSpaceRules,
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

test('leading spaces remain a third sidebar row alongside two agent suggestions', () => {
    const html = '<p>&nbsp;&nbsp;&nbsp;<em>Schrijf hier een korte, krachtige titel.</em></p><p>fdlkjg</p>';
    const feedback = {
        Suggesties: [
            { Origineel: 'Schrijf hier', Suggestie: 'Schrijf hier:', Uitleg: 'Voeg een dubbele punt toe.' },
            { Origineel: 'titel.\nfdlkjg', Suggestie: 'titel.', Uitleg: 'Verwijder de losse tekst.' }
        ]
    };
    const agent = feedbackToSuggestions(feedback, 'block-h1', 'h1', 'agent_spelling_grammatica', '', 'spelling', html);
    const rows = mergeSpellingSuggestionsWithLocalSpaceRules(html, 'block-h1', 'h1', agent);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].original, '   ');
    assert.equal(suggestionDisplayText(rows[2].original, rows[2].explanation), 'Gebruik een enkele spatie.');
    assert.equal(rows[2].suggested, ' ');
});

test('whitespace-only AI suggestions survive parsing in array and legacy responses', () => {
    const correction = { Origineel: '  ', Suggestie: ' ', Uitleg: 'Gebruik een enkele spatie.' };
    for (const feedback of [{ Suggesties: [correction] }, correction]) {
        const html = '<p>Een  voorbeeld.</p>';
        const agent = feedbackToSuggestions(feedback, 'block-h1', 'h1', 'agent_spelling_grammatica', '', 'spelling', html);
        assert.equal(agent.length, 1);
        assert.equal(agent[0].original, '  ');
        assert.equal(agent[0].suggested, ' ');
        assert.equal(agent[0].canAccept, true);
        const rows = mergeSpellingSuggestionsWithLocalSpaceRules(html, 'block-h1', 'h1', agent);
        assert.equal(rows.length, 1, 'the local rule must not duplicate the AI correction');
    }
});

test('inline formatting and editor highlight spans do not create extra space suggestions', () => {
    const clean = '<p>Een <em>voorbeeld</em> hier.</p>';
    const highlighted = '<p>Een <em><span class="ai-highlight">voorbeeld</span></em> hier.</p>';
    for (const html of [clean, highlighted]) {
        assert.deepEqual(localMultiSpaceSuggestions(html, 'block-h1', 'h1'), []);
    }
    const withSpaces = '<p>Een  <em>voorbeeld</em> hier.</p>';
    const withHighlights = '<p>Een  <em><span class="ai-highlight">voorbeeld</span></em> hier.</p>';
    assert.deepEqual(
        localMultiSpaceSuggestions(withSpaces, 'block-h1', 'h1'),
        localMultiSpaceSuggestions(withHighlights, 'block-h1', 'h1')
    );
});

test('a whitespace-only AI correction is not actionable when those spaces are absent', () => {
    const correction = { Origineel: '  ', Suggestie: ' ', Uitleg: 'Gebruik een enkele spatie.' };
    for (const feedback of [{ Suggesties: [correction] }, correction]) {
        const html = '<p>Een voorbeeld.</p>';
        const agent = feedbackToSuggestions(feedback, 'block-h1', 'h1', 'agent_spelling_grammatica', '', 'spelling', html);
        assert.equal(agent[0].canAccept, false);
        assert.deepEqual(mergeSpellingSuggestionsWithLocalSpaceRules(html, 'block-h1', 'h1', agent), []);
    }
});
