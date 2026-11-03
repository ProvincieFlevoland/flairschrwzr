import assert from 'node:assert/strict';
import { fixtureNotaCopy } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, highlights, nonB1Words, sidebarRow, sidebarRowIds, waitFor, cellSel, agentCalls, sleep } from '../lib/app.mjs';

const ID_SHAPE = /^(agent_b1|spelling|agent_woordenlijst)-h2-block-h2-\d+$/;   //

/** switch sidebar tabs -> highlight spans with source-structuur/b1/spelling/woordenlijst appear only for the active tab;
 *  non-B1 words are marked only on Direct Duidelijk; hovering a row adds `hovered-from-sidebar`. */
export default {
  id: 'sidebar-tab-highlights', title: 'sidebar tab drives editor highlights; hover marks the span',
  async run({ page, adapter, api, rec, record, cleanup }) {
    // a copy of the WIP fixture with every block in concept (the fixture itself has h2 in review and h3 done, which locks them)
    const stored = fixtureNotaCopy('nota-wip.json', 'sidebar-tab-highlights', { blockWorkflow: {} });
    await api.putNota(stored);
    cleanup(() => api.deleteNota(stored.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, stored.title);
    await runCellAi(page, rec, 'h2');
    // woordenlijst agent: not in the automatic chain; needs the active block -> jump via the workflow strip (no editor focus)
    await page.locator('button[aria-label^="Blok: Beslispunten"]').click();
    await selectTab(page, 'woordenlijst');
    const since = Date.now();
    await page.locator('.pane-list button[class*="btn-primary"]').first().click();
    await waitFor(() => agentCalls(rec, since).find((c) => c.assignment === 'agent_woordenlijst' && c.doneTs), { what: 'woordenlijst call' });
    await sleep(300);

    const perTab = {};
    const expectSources = { structuur: ['b1', 'spelling', 'woordenlijst'], overview: [], spelling: ['spelling'], b1: ['b1'], woordenlijst: ['woordenlijst'] };
    for (const tab of ['overview', 'spelling', 'b1', 'woordenlijst', 'structuur']) {
      await selectTab(page, tab);
      const hl = await highlights(page, 'h2');
      const sources = [...new Set(hl.map((h) => h.source))].sort();
      const structuurAttr = await page.locator(`${cellSel('h2')} .cell-content-wrapper`).getAttribute('data-structuur-ids');
      const nonB1 = await nonB1Words(page, 'h2');
      perTab[tab] = { sources, spans: hl.length, structuur_marked: !!structuurAttr, non_b1_words: nonB1.length };
      assert.deepEqual(sources, expectSources[tab].slice().sort(), `tab ${tab}: highlight sources`);
      for (const h of hl) assert.match(h.id, ID_SHAPE, `span id shape: ${h.id}`);
      // structuur has no span: the cell wrapper carries data-structuur-ids on tabs whose filter includes structuur
      const structuurExpected = tab === 'overview' || tab === 'structuur';
      assert.equal(!!structuurAttr, structuurExpected, `tab ${tab}: structuur marking on the cell`);
      if (structuurExpected) assert.match(structuurAttr, /^agent_structuur-h2-block-h2-0$/);
      // non-B1 words (red) would be marked only on Direct Duidelijk (BlockEditor.applyWordListHighlight with the config's
      // woordenlijst). Never marked for an auteur, because +page.svelte loadConfigurationsFromAzure stores only the
      // hoofdstukken/terminologie/regels subfolders and drops `woordenlijst` (+page.svelte:76-87); only the AdminDashboard loads it.
      // Pinned.
      assert.equal(nonB1.length, 0, `tab ${tab}: no non-B1 word marking`);
    }
    record('per_tab', perTab);
    assert.ok(perTab.spelling.spans >= 3 && perTab.b1.spans >= 2 && perTab.woordenlijst.spans >= 2, `spans per tab: ${JSON.stringify(perTab)}`);

    // hover: a sidebar row hovered -> its span gets hovered-from-sidebar, others not
    await selectTab(page, 'b1');
    const rowId = (await sidebarRowIds(page)).find((id) => id.startsWith('agent_b1-h2-'));
    await sidebarRow(page, rowId).hover();
    await waitFor(async () => (await highlights(page, 'h2')).some((h) => h.hovered), { what: 'hovered-from-sidebar' });
    const hovered = (await highlights(page, 'h2')).filter((h) => h.hovered).map((h) => h.id);
    record('hovered', hovered);
    assert.deepEqual(hovered, [rowId]);
    await page.mouse.move(5, 500);
    await waitFor(async () => !(await highlights(page, 'h2')).some((h) => h.hovered), { what: 'hover cleared' });
  },
};
