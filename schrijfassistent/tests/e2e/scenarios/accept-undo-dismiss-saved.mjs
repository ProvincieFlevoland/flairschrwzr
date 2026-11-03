import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modal, modalAccept, modalDeny, cellText, highlights, putCalls, waitFor, sleep, localGetJson } from '../lib/app.mjs';

const H2 = '<p>Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis. Wij verzoeken u dit te accorderen. Daarna volgt de rest.</p>';
const ORIGINAL = 'Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.';
const APPLIED = 'Een parkeergarage te bouwen onder het provinciehuis.';

/** the suggestion flows reach what is saved. Accept a Direct Duidelijk row -> the debounced PUT and the
 *  per-user cache carry the applied text; undo -> the next PUT carries the original text again; dismiss the other row -> its row and highlight go, the text is
 *  untouched, and the raw agent answers stay in the saved nota (`chapterFeedbacksB1`). The cell text of accept and undo is covered by accept-undo-own-block; this scenario follows the text
 *  through autosave. */
export default {
  id: 'accept-undo-dismiss-saved', title: 'accept, undo and dismiss reach the saved nota', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('accept-undo-dismiss-saved', { content: notaHtml({ h2: H2 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    await runCellAi(page, rec, 'h2');
    await selectTab(page, 'b1');
    const b1 = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-'));
    assert.deepEqual(b1, ['agent_b1-h2-block-h2-0', 'agent_b1-h2-block-h2-1']);
    const lastPut = async (since) => (await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length && p[p.length - 1].doneTs ? p[p.length - 1] : null; }, { timeout: 20000, what: 'autosave PUT' }));

    // 1. accept -> saved with the applied text
    const tAccept = Date.now();
    await openRowModal(page, b1[0]);
    await page.keyboard.press('1');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    const put1 = await lastPut(tAccept);
    const saved1 = JSON.parse(put1.postData);
    assert.ok(saved1.content.includes(APPLIED), 'the PUT carries the applied text');
    assert.ok(!saved1.content.includes(ORIGINAL), 'the original sentence is gone from the PUT');
    assert.ok(saved1.chapterFeedbacksB1?.h2, 'the raw Direct Duidelijk answer is saved with the nota');
    const cache1 = (await localGetJson(page, 'gs_nota_db')).notas.find((n) => n.id === nota.id);
    assert.equal(cache1.content, saved1.content, 'the per-user cache holds exactly what was saved');

    // 2. undo -> saved with the original text again
    await sleep(1500);
    const tUndo = Date.now();
    await page.locator(`[data-sidebar-suggestion-id="${b1[0]}"]`).first().locator('button').first().click();
    await page.getByRole('button', { name: 'Ongedaan maken' }).click();
    const put2 = await lastPut(tUndo);
    const saved2 = JSON.parse(put2.postData);
    assert.ok(saved2.content.includes(ORIGINAL), 'after undo the PUT carries the original sentence');
    assert.ok(!saved2.content.includes(APPLIED), 'the applied sentence is gone from the PUT');
    assert.equal((await cellText(page, 'h2')).includes(ORIGINAL), true);

    // 3. dismiss the second row: the row and its highlight go, the text stays
    await sleep(1500);
    const before = await cellText(page, 'h2');
    await openRowModal(page, b1[1]);
    await modalDeny(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(300);
    const rowsAfter = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-'));
    record('rows_after_dismiss', rowsAfter);
    // B1 rows keep a handled entry after a deny (label "Afgewezen"); only the active row and its highlight go.
    assert.ok(rowsAfter.includes(b1[1]), 'the dismissed row stays listed as handled');
    const handled = await page.locator(`[data-sidebar-suggestion-id="${b1[1]}"]`).first().innerText();
    record('handled_text', handled); assert.ok(/afgewezen/i.test(handled), 'the dismissed row is labelled Afgewezen: ' + JSON.stringify(handled));
    assert.ok(rowsAfter.includes(b1[0]), 'the other row stays');
    assert.ok(!(await highlights(page, 'h2')).some((h) => h.id === b1[1]), 'the dismissed row\'s highlight is gone');
    assert.equal(await cellText(page, 'h2'), before, 'dismiss does not touch the text');
  },
};
