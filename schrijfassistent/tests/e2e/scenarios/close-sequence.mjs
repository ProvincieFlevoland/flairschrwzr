import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, openRowModal, modal, cellContent, cellHtml, putCalls, waitFor, sleep, setSetting, typeInCell } from '../lib/app.mjs';

const H3 = '<p>Wij verzoeken u dit te accorderen. Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.</p>';
const TEXT = 'Parkeergarage onder het provinciehuis bouwen voor bezoekers en medewerkers.';
const closeDialog = (page) => page.locator('[role="dialog"][aria-labelledby="close-modal-title"]');

/** Esc with a suggestion modal open closes the modal; Esc again with the caret in a cell changes
 *  nothing; the app's close button with a save pending asks for confirmation (cancel keeps the screen), then one PUT completes, the timers
 *  are cleared (no agent call, title call or second PUT afterwards) and the container is removed through onClose -> unmount().
 *  */
export default {
  id: 'close-sequence', title: 'Esc handling and close sequence of the embedded container', timeout: 120000,
  async run({ page, adapter, api, rec, record, cleanup, env }) {
    {
      // a host-level keydown listener on `document`, the way Open WebUI registers its global shortcuts: it records what reaches the host
      await page.addInitScript(() => { document.addEventListener('keydown', (e) => { (window.__hostKeys ||= []).push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }); }); });
    }
    // default title and not manually set: typing arms the auto-title timer next to the auto-AI timer and the autosave debounce
    const nota = scratchNota('close-sequence', { title: 'Nieuwe Concept Nota', titleManuallySet: false, content: notaHtml({ h3: H3 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await setSetting(page, 'Auto-AI na typen', true);            // default off (uiStore.js); typing then arms the 10 s countdown
    await openNota(page, nota.title);
    await runCellAi(page, rec, 'h3');

    // 1. Esc with a suggestion modal open closes the modal
    await selectTab(page, 'spelling');
    await openRowModal(page, 'spelling-h3-block-h3-2');
    assert.ok(await modal(page).isVisible(), 'modal open');
    await page.keyboard.press('Escape');
    await modal(page).waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await page.locator('#sa-container').count(), 1, 'the container stays after Esc');
    assert.equal(await page.locator('.editor-cell[data-block-id="block-h3"]').count(), 1, 'the editor stays after Esc');
    // the Esc closed the modal only: the row is not dismissed
    assert.equal(await page.locator('[data-sidebar-suggestion-id="spelling-h3-block-h3-2"]').count() > 0, true, 'the suggestion list is unchanged (closeOnly)');

    // 2. Esc with the caret in a cell and no modal changes nothing (a click in a cell with structuur feedback opens that modal; Esc closes it first)
    await cellContent(page, 'h3').click();
    await sleep(300);
    if (await modal(page).isVisible()) { await page.keyboard.press('Escape'); await modal(page).waitFor({ state: 'hidden', timeout: 5000 }); }
    const htmlBefore = await cellHtml(page, 'h3');
    await page.keyboard.press('Escape');
    await sleep(300);
    assert.equal(await cellHtml(page, 'h3'), htmlBefore, 'Esc in a cell leaves the text alone');
    assert.equal(await page.locator('#sa-container').count(), 1, 'Esc in a cell does not close the app');
    assert.equal(await modal(page).isVisible(), false, 'no modal appeared');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.cell-content')), true, 'the caret stays in the cell');
    const putsBeforeEdit = putCalls(rec, nota.id).length;

    // 2b. host shortcuts. Chords typed inside the app do not reach a `document` listener (the way Open WebUI binds its shortcuts);
    // plain keys still do, and Esc with a modal open still closes the modal (step 1).
    {
      await page.evaluate(() => { window.__hostKeys = []; });
      await cellContent(page, 'h1').click();
      for (const chord of ['Control+k', 'Control+/', 'Control+Shift+o', 'Control+Shift+Backspace', 'Shift+Escape', 'Meta+k']) await page.keyboard.press(chord);
      await page.keyboard.press('q');
      const seen = await page.evaluate(() => window.__hostKeys);
      record('host_keys_after_chords', seen);
      assert.deepEqual(seen.filter((k) => k.ctrl || k.meta), [], 'no ctrl/meta chord reaches the host document');
      assert.deepEqual(seen.filter((k) => k.shift && k.key === 'Escape'), [], 'Shift+Esc does not reach the host document');
      assert.ok(seen.some((k) => k.key === 'q' && !k.ctrl && !k.meta), 'a plain key still reaches the host (only chords are stopped)');
      await page.evaluate(() => { window.__hostKeys = []; });
    }

    // 3. type in the first chapter (arms autosave, auto-AI and auto-title), then close: confirmation first; cancel keeps the screen
    await typeInCell(page, 'h1', TEXT);
    const since = Date.now();
    await page.locator('.user-badge').click();
    await closeDialog(page).waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(putCalls(rec, nota.id, since).length, 0, 'asking for confirmation saves nothing yet');
    await closeDialog(page).getByRole('button', { name: 'Annuleren' }).click();
    await closeDialog(page).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#sa-container').count(), 1, 'Annuleren keeps the app open');
    assert.equal(putCalls(rec, nota.id, since).length, 0, 'Annuleren saves nothing');

    // 4. confirm: one PUT completes, then the container is removed
    await page.locator('.user-badge').click();
    await closeDialog(page).waitFor({ state: 'visible', timeout: 5000 });
    await closeDialog(page).getByRole('button', { name: 'Opslaan en sluiten' }).click();
    const puts = await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length && p[0].doneTs ? p : null; }, { what: 'PUT on close', timeout: 20000 });
    const closedAt = Date.now();
    await page.waitForSelector('#sa-container', { state: 'detached', timeout: 15000 });
    assert.equal(puts.length, 1, 'exactly one PUT on close');
    assert.equal(puts[0].status, 200);
    assert.ok(JSON.parse(puts[0].postData).content.includes(TEXT), 'the PUT carries the typed text');
    assert.equal(await page.evaluate(() => window.__saHarness?.closedCount), 1, 'onClose reached the host once');
    assert.ok(puts[0].doneTs <= closedAt + 50, 'the save finished before the container was removed');
    record('puts_before_edit', putsBeforeEdit);

    // 5. no timer fires after the close: the auto-AI countdown (10 s), the auto-title timer (15 s) and the autosave debounce (10 s)
    await sleep(17000);
    const late = rec.requests.filter((r) => r.ts > closedAt + 50 && /generate-agent-response|generate-nota-title|\/storage\/notas\//.test(r.url) && r.method !== 'GET');
    record('requests_after_close', late.map((r) => `${r.method} ${new URL(r.url).pathname}`));
    assert.deepEqual(late, [], 'no agent call, no title call and no second PUT after the close');
    {
      // measurement: what a host `document` keydown listener saw of the keys typed and pressed in the app
      const keys = await page.evaluate(() => window.__hostKeys || []);
      record('host_document_keydown_saw', { count: keys.length, ctrl_or_meta: keys.filter((k) => k.ctrl || k.meta).length, typed: keys.filter((k) => k.key.length === 1 && !k.ctrl && !k.meta).map((k) => k.key).join('') });
      assert.equal(keys.filter((k) => k.ctrl || k.meta).length, 0, 'Ctrl+A and the other chords of the edit never reached the host');
    }
  },
};
