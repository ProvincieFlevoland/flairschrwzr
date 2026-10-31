import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, backToDashboard, typeInCell, putCalls, waitFor, headerStatusIcon, notaItem } from '../lib/app.mjs';

/** Type, wait 10 s, then switch nota -> one PUT from the debounce and nothing more; the header status icon shows success after a save.
 *
 *  "Terug naar Overzicht" saves a nota with pending edits before the dashboard loads the list
 *  and then forgets the active nota, so a nota the debounce already saved is not sent again, neither on the back nor when the next nota is opened.
 *  The header has no pending/saving indicator; only `success` (check icon) and `error` are shown. */
export default {
  id: 'autosave-debounce', title: 'autosave: debounce PUT, PUTs on switching nota, status icon', timeout: 120000,
  async run({ page, adapter, api, rec, record, cleanup, env }) {
    const a = scratchNota('autosave-debounce', { title: 'Test A' });
    const b = scratchNota('autosave-debounce', { title: 'Test B' });
    await api.putNota(a); await api.putNota(b);
    cleanup(() => api.deleteNota(a.id)); cleanup(() => api.deleteNota(b.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, a.title);
    assert.equal(await headerStatusIcon(page), 'none');
    const tEnd = await typeInCell(page, 'h2', 'Een eerste zin voor de autosave.');
    const since = tEnd - 5000;
    // nothing before the debounce elapses (sampled at 8 s)
    await page.waitForTimeout(8000);
    assert.equal(putCalls(rec, a.id, since).length, 0, 'no PUT before the 10 s debounce');
    assert.equal(await headerStatusIcon(page), 'none', 'no success icon yet (pending/saving have no icon)');
    const first = await waitFor(() => { const p = putCalls(rec, a.id, since); return p.length && p[0].doneTs ? p : null; }, { timeout: 8000, what: 'debounced PUT' });
    const dt = first[0].ts - tEnd;
    record('debounce_offset_ms', dt);
    assert.ok(dt >= 9000 && dt <= 12500, `debounce PUT at ${dt} ms`);
    assert.equal(first[0].status, 200);
    assert.ok(JSON.parse(first[0].postData).content.includes('Een eerste zin voor de autosave.'));
    assert.equal(first[0].headers['x-nota-base-modified'], a.lastModified, 'the first PUT carries the lastModified the list loaded');
    await waitFor(async () => (await headerStatusIcon(page)) === 'success', { timeout: 3000, what: 'success icon' });
    await waitFor(async () => (await headerStatusIcon(page)) === 'none', { timeout: 3000, what: 'icon back to idle after ~1 s' });
    await page.waitForTimeout(1500);
    assert.equal(putCalls(rec, a.id, since).length, 1, 'exactly one PUT from the debounce');
      // a second save in the same session carries the lastModified of the first PUT as base (the base advances after a success)
      const t2 = await typeInCell(page, 'h2', 'Een tweede zin voor de autosave.');
      const second = await waitFor(() => { const p = putCalls(rec, a.id, Math.max(t2 - 2000, first[0].ts + 1)); return p.length && p[0].doneTs ? p : null; }, { timeout: 16000, what: "second debounced PUT" });
      assert.equal(second[0].status, 200);
      assert.equal(second[0].headers['x-nota-base-modified'], JSON.parse(first[0].postData).lastModified, 'the second PUT carries the lastModified of the first PUT as base');
      await page.waitForTimeout(1500);
    

    // switch nota: A is clean (the debounce saved it), so the back sends nothing and opening B sends nothing for A either
    const tBack = Date.now();
    await backToDashboard(page);
    await page.waitForTimeout(2000);
    const tOpen = Date.now();
    const onBack = putCalls(rec, a.id, tBack);
    const n0 = putCalls(rec, a.id, since).length;
    await notaItem(page, b.title).click();
    await page.getByRole('button', { name: 'Bewerk Nota' }).click();
    await page.waitForSelector('.editor-cell[data-block-id]');
    await page.waitForTimeout(1500);
    record('puts_for_A', { debounce: 1, on_back: onBack.length, on_open_other: putCalls(rec, a.id, tOpen).length });
    assert.equal(onBack.length, 0, '"Terug naar Overzicht" sends nothing for a nota the debounce already saved');
    assert.equal(putCalls(rec, a.id, tOpen).length, 0, 'opening the next nota sends nothing for A: the back navigation settled it');
    assert.equal(putCalls(rec, b.id, since).length, 0, 'B was not saved (not edited)');
    assert.equal(putCalls(rec, a.id, since).length, n0, 'total for A: the debounce(s) only');
  },
};
