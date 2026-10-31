import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modalDeny, modal, cellContent, cellSel, highlights, sleep, localGetJson } from '../lib/app.mjs';

const H3 = '<p>Wij verzoeken u dit te accorderen. Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.</p>';

/** set block h3 to Klaar -> cell contenteditable="false"; AI button gone/disabled; only handled suggestions visible. */
export default {
  id: 'block-workflow-klaar', title: 'block workflow Klaar locks the cell and hides open suggestions',
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('block-workflow-klaar', { content: notaHtml({ h3: H3 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    await runCellAi(page, rec, 'h3');

    // open suggestions exist: handle one (dismiss the spelling row "accorderen") and leave the rest open
    await selectTab(page, 'spelling');
    const spellingBefore = (await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-h3-'));
    record('spelling_rows_before', spellingBefore);
    assert.ok(spellingBefore.includes('spelling-h3-block-h3-2'), 'agent row "accorderen" present');
    await openRowModal(page, 'spelling-h3-block-h3-2');
    await modalDeny(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await selectTab(page, 'b1');
    const b1Before = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-h3-'));
    assert.ok(b1Before.length >= 2, `open B1 rows before Klaar: ${b1Before}`);

    // activate block h3 (a cell with structuur feedback opens the structuur modal on click; close it) and pick Klaar
    await cellContent(page, 'h3').click();
    if (await modal(page).isVisible()) await modal(page).getByRole('button', { name: 'Sluiten' }).click();
    const klaar = page.locator(`.editor-desk-row:has(${cellSel('h3')}) button[role="radio"][title="Klaar"]`);
    await klaar.click();
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('contenteditable') === 'false', `${cellSel('h3')} .cell-content`);
    await sleep(300);

    assert.equal(await cellContent(page, 'h3').getAttribute('contenteditable'), 'false');
    // The AI button is removed: `{#if !workflowReadOnly || isAnalyzing}` (BlockEditor.svelte:579).
    const aiBtn = await page.locator(`${cellSel('h3')} .cell-ai-btn`).count();
    record('cell_ai_button_when_done', aiBtn === 0 ? 'removed from the DOM (not disabled)' : 'present');
    assert.equal(aiBtn, 0, 'cell AI button is not rendered for a done block');
    // The "Afgerond" pill (BlockEditor.svelte:572-575) is NOT rendered on a cell that had highlights painted: applyHighlight()'s
    // root.normalize() dropped the empty text node Svelte uses as the {#if workflowReadOnly} anchor.
    const pillH3 = await page.locator(`${cellSel('h3')} [class*="wf-done-pill"]`).count();
    record('afgerond_pill_h3_after_highlights', pillH3);
    assert.equal(pillH3, 0, 'no Afgerond pill on a block whose highlights were painted');
    // the sidebar's AI entry point (woordenlijst tab button) is disabled for the active done block
    await selectTab(page, 'woordenlijst');
    assert.equal(await page.locator('.pane-list button[class*="btn-primary"]').first().isDisabled(), true, 'sidebar AI button disabled');

    // only handled suggestions visible — in the EDITOR: Workspace.filterSuggestionsForEditor (keyed by block id) keeps only
    // dismissed/accepted rows, and syncLastSuggestionsFromNota already drops dismissed ids from lastSuggestions, so a done
    // block shows no highlight at all (Workspace.svelte:279-283, 626-629).
    await selectTab(page, 'structuur');
    const hl = await highlights(page, 'h3');
    record('highlights_after_done', hl.map((h) => h.id));
    assert.deepEqual(hl, [], 'no open highlight in the editor for a done block');
    assert.equal(await page.locator(`${cellSel('h3')} .cell-content-wrapper[data-structuur-ids]`).count(), 0, 'open structuur marking gone');
    // ... but NOT in the sidebar: AuteurPane.filterSuggestionsByWorkflow reads blockWorkflowMap[chapterId] ("h3") while the map is
    // keyed "block-h3" (AuteurPane.svelte:871-879), so the open rows stay listed. Pinned behaviour.
    await selectTab(page, 'spelling');
    const spellingAfter = (await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-h3-'));
    assert.deepEqual(spellingAfter, ['spelling-h3-block-h3-2'], 'spelling: the dismissed row stays listed as handled');
    await selectTab(page, 'b1');
    const b1After = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-h3-'));
    record('sidebar_b1_rows_after_done', b1After);
    assert.deepEqual(b1After, b1Before, 'sidebar still lists the open B1 rows of a done block');

    // control: a block that never had highlights does show the pill when set to Klaar
    await cellContent(page, 'h4').click();
    await page.locator(`.editor-desk-row:has(${cellSel('h4')}) button[role="radio"][title="Klaar"]`).click();
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('contenteditable') === 'false', `${cellSel('h4')} .cell-content`);
    assert.ok(await page.locator(`${cellSel('h4')} :text("Afgerond")`).first().isVisible(), 'Afgerond pill on a block without painted highlights');

    // persisted state: blockWorkflow block-h3 = done in the local DB; the backend accepts it on the next sync
    const wf = (await localGetJson(page, 'gs_nota_db')).notas.find((n) => n.id === nota.id).blockWorkflow;
    assert.deepEqual(wf, { 'block-h3': 'done', 'block-h4': 'done' });
    // typing into the locked cell changes nothing
    const before = await cellContent(page, 'h3').evaluate((el) => el.innerHTML);
    await cellContent(page, 'h3').click({ force: true });
    await page.keyboard.type('xyz');
    assert.equal(await cellContent(page, 'h3').evaluate((el) => el.innerHTML), before, 'locked cell ignores typing');
  },
};
