import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, typeInCell, putCalls, waitFor, toasts } from '../lib/app.mjs';

const FULL = 'De lokale cache is vol of niet beschikbaar';
const MINE = 'Tekst terwijl de lokale opslag vol is.';

/** `localStorage.setItem` throws QuotaExceededError (a full 5 MB origin shared with Open WebUI).
 *  Typing raises no uncaught error, one toast tells the auteur that the cache is not being kept, and the autosave still sends the text to the backend. */
export default {
  id: 'full-local-storage', title: 'a full localStorage: one toast, no uncaught error, autosave keeps working', timeout: 90000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('full-local-storage', { title: 'Test full local storage' });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }; });
    const tEnd = await typeInCell(page, 'h2', MINE);
    await typeInCell(page, 'h2', MINE + ' Nog meer tekst.');
    await waitFor(async () => (await toasts(page)).some((t) => t.includes(FULL)), { timeout: 5000, what: 'cache toast' });
    assert.equal((await toasts(page)).filter((t) => t.includes(FULL)).length, 1, 'one toast, not one per keystroke');
    const puts = await waitFor(() => { const p = putCalls(rec, nota.id, tEnd - 5000); return p.length && p[0].doneTs ? p : null; }, { timeout: 20000, what: 'autosave PUT without the cache' });
    record('put_status', puts[0].status);
    assert.equal(puts[0].status, 200);
    assert.ok(JSON.parse(puts[0].postData).content.includes('Nog meer tekst.'), 'the PUT carries the latest text');
    assert.deepEqual(errors, [], 'no uncaught error from the storage failure');
    assert.ok((await api.getNota(nota.id)).content.includes('Nog meer tekst.'));
  },
};
