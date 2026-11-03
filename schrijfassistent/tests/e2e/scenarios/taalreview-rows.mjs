import assert from 'node:assert/strict';
import { fixtureNotaCopy } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, highlights, agentCalls, openRowModal, modal, modalAccept } from '../lib/app.mjs';

/** spelling fixture with `Origineel: "twee  spaties"` (sent by the model as nbsp+space) and an `&nbsp;` original -> rows appear with
 *  canAccept true for both; the local double-space / space-before-punctuation rows are suppressed where an agent row covers them.
 *  Block h2 of the WIP fixture reads "... Dit kost twee&nbsp; spaties en een&nbsp;harde spatie ." (fixtures/notas/nota-wip.json). */
export default {
  id: 'taalreview-rows', title: 'taalreview rows: nbsp/double-space originals accepted, local rows suppressed',
  async run({ page, adapter, api, rec, record, cleanup }) {
    // a copy of the WIP fixture with every block in concept (the fixture itself has h2 in review and h3 done, which locks them)
    const stored = fixtureNotaCopy('nota-wip.json', 'taalreview-rows', { blockWorkflow: {} });
    await api.putNota(stored);
    cleanup(() => api.deleteNota(stored.id));
    assert.ok(stored.content.includes('twee&nbsp; spaties en een&nbsp;harde spatie .'), 'fixture text as expected');
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, stored.title);
    await runCellAi(page, rec, 'h2');

    // the taalreview request carries the normalised plain text: entities and U+00A0 -> space, tags -> space. The snapshot is the
    // LIVE cell HTML, which already carries the local-rule highlight spans (" ." and the double space), so extra spaces appear around
    // them; compare whitespace-collapsed.
    const spellingCall = agentCalls(rec).find((c) => c.assignment === 'agent_spelling_grammatica' && c.chapter === 'h2');
    record('taalreview_user_message', spellingCall.userMessage);
    assert.ok(!/\u00a0|&nbsp;/.test(spellingCall.userMessage), 'no nbsp (entity or U+00A0) reaches the agent');
    const h2body = stored.content.split('data-chapter-id="h2">Beslispunten</h2>')[1].split('<h2 ')[0];
    const collapse = (t) => t.replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(collapse(spellingCall.userMessage), collapse(h2body), 'plain text of the whole h2 block (both paragraphs), tags stripped');

    await selectTab(page, 'spelling');
    const rows = (await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-h2-'));
    record('spelling_rows', rows);
    assert.deepEqual(rows, ['spelling-h2-block-h2-0', 'spelling-h2-block-h2-1', 'spelling-h2-block-h2-2'],
      'the three agent rows (ids `${prefix}-${chapterId}-${blockId}-${idx}`), no `-local-` rows: "twee  spaties" covers the double space and "een harde spatie ." covers " ."');
    // visible rows are the canAccept ones (mergeSpellingSuggestionsWithLocalSpaceRules drops canAccept:false agent rows)
    const texts = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar-suggestion-id^="spelling-h2-"]')].map((el) => el.querySelector('div > div')?.textContent.trim()));
    record('row_texts', texts);
    assert.deepEqual(texts.map((t) => t.replace(/\u00a0/g, ' ')), ['twee  spaties', 'een harde spatie .', 'accorderen']);
    // highlights in the cell on the spelling tab, one per row, matched through the nbsp normalisation
    const hl = await highlights(page, 'h2');
    record('highlights', hl.map((h) => `${h.source}:${h.id}:${JSON.stringify(h.text)}`));
    assert.ok(hl.every((h) => h.source === 'spelling'));
    const agentSpans = hl.filter((h) => rows.includes(h.id));
    assert.deepEqual(agentSpans.map((h) => h.id).sort(), rows.slice().sort(), 'one highlight span per agent row');
    assert.deepEqual(agentSpans.map((h) => h.text.replace(/\u00a0/g, ' ')).sort(), ['accorderen', 'een harde spatie .', 'twee  spaties']);
    // Workspace.syncLastSuggestionsFromNota feeds the LIVE cell HTML (including the spans it painted before the agent run) to the
    // local space rules, so whitespace created by span boundaries can surface as an extra `-local-` highlight the sidebar does not
    // list. Tolerated only in that shape: a local id with whitespace-only text.
    const extra = hl.filter((h) => !rows.includes(h.id));
    record('extra_editor_only_highlights', extra.map((h) => `${h.id}:${JSON.stringify(h.text)}`));
    for (const h of extra) assert.ok(/-local-\d+$/.test(h.id) && /^[\s\u00a0]+$/.test(h.text), `unexpected editor-only highlight ${h.id} ${JSON.stringify(h.text)}`);
    // canAccept true: the modal's accept button is enabled for the nbsp row and the double-space row
    for (const id of ['spelling-h2-block-h2-0', 'spelling-h2-block-h2-1']) {
      await openRowModal(page, id);
      assert.equal(await modalAccept(page).isDisabled(), false, `${id}: Accepteren enabled (canAccept)`);
      await modal(page).getByRole('button', { name: 'Sluiten' }).click();
      await modal(page).waitFor({ state: 'hidden' });
    }
  },
};
