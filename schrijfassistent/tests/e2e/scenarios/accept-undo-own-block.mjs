import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modal, modalAccept, cellText, putCalls, waitFor, sleep } from '../lib/app.mjs';

const SAME = '<p>Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis. Wij verzoeken u dit te accorderen. Daarna volgt de rest.</p>';
const ORIGINAL = 'Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.';
const APPLIED = 'Een parkeergarage te bouwen onder het provinciehuis.';
const count = (s, sub) => s.split(sub).length - 1;

/** the same sentence stands in two chapters (a repeated "Kennis te nemen van" is normal in a GS-nota).
 *  Accepting a Direct Duidelijk row of the h3 chapter changes the h3 cell and only that one: the h2 cell keeps its text, the saved nota holds the
 *  applied sentence once and the original sentence once, and undo restores h3 without touching h2. An accept that was applied to every block
 *  fails here; the single-chapter scenarios cannot see it. */
export default {
  id: 'accept-undo-own-block', title: 'accept and undo change only their own block when two chapters hold the same text', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('accept-undo-own-block', { content: notaHtml({ h2: SAME, h3: SAME }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const h2Before = await cellText(page, 'h2');
    assert.equal(h2Before, await cellText(page, 'h3'), 'both chapters hold the same text');
    await runCellAi(page, rec, 'h3');
    await selectTab(page, 'b1');
    const b1 = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-h3-'));
    record('b1_rows_h3', b1);
    assert.ok(b1.length >= 1, 'the h3 chapter has a Direct Duidelijk row');

    const tAccept = Date.now();
    await openRowModal(page, b1[0]);
    await page.keyboard.press('1');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    assert.ok((await cellText(page, 'h3')).includes(APPLIED), 'the h3 cell holds the applied sentence');
    assert.equal(await cellText(page, 'h2'), h2Before, 'the h2 cell is untouched');
    const put = await waitFor(() => { const p = putCalls(rec, nota.id, tAccept); return p.length && p[p.length - 1].doneTs ? p[p.length - 1] : null; }, { timeout: 20000, what: 'autosave PUT after accept' });
    const saved = JSON.parse(put.postData).content;
    assert.equal(count(saved, APPLIED), 1, 'the applied sentence is saved once');
    assert.equal(count(saved, ORIGINAL), 1, 'the original sentence is saved once (the h2 chapter)');

    await sleep(1500);
    const tUndo = Date.now();
    await page.locator(`[data-sidebar-suggestion-id="${b1[0]}"]`).first().locator('button').first().click();
    await page.getByRole('button', { name: 'Ongedaan maken' }).click();
    const put2 = await waitFor(() => { const p = putCalls(rec, nota.id, tUndo); return p.length && p[p.length - 1].doneTs ? p[p.length - 1] : null; }, { timeout: 20000, what: 'autosave PUT after undo' });
    const saved2 = JSON.parse(put2.postData).content;
    assert.equal(count(saved2, APPLIED), 0, 'undo removes the applied sentence');
    assert.equal(count(saved2, ORIGINAL), 2, 'both chapters hold the original sentence again');
    assert.equal(await cellText(page, 'h2'), h2Before);
    assert.equal(await cellText(page, 'h3'), h2Before);
  },
};
