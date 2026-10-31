import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, typeInCell, putCalls, waitFor, headerStatusIcon, toasts } from '../lib/app.mjs';

/** make the backend return 500 twice, then 200 -> three PUT attempts 5 s apart, then success.
 *  The retries show warning toasts "Autosave mislukt, opnieuw proberen... (poging n/3)"; the success is the header check
 *  icon, not a toast (autosaveStore.js:170-176 "no toast notification"). */
export default {
  id: 'autosave-retries', title: 'autosave retries: 500, 500, 200 at 5 s intervals', timeout: 120000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('autosave-retries');
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    let attempts = 0;
    await page.route((u) => /\/api\/v1\/storage\/notas\//.test(u.href), (route) => {
      if (route.request().method() === 'PUT' && decodeURIComponent(route.request().url()).includes(nota.id)) {
        attempts += 1;
        if (attempts <= 2) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'injected failure' }) });
      }
      return route.continue();
    });
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const tEnd = await typeInCell(page, 'h2', 'Tekst die drie keer wordt opgeslagen.');
    const since = tEnd - 5000;
    const seenToasts = new Set();
    const puts = await waitFor(async () => {
      for (const t of await toasts(page)) seenToasts.add(t);
      const p = putCalls(rec, nota.id, since);
      return p.length >= 3 && p[2].doneTs ? p : null;
    }, { timeout: 35000, interval: 250, what: 'three PUT attempts' });
    const offsets = puts.map((p) => p.ts - tEnd);
    record('put_offsets_ms', offsets);
    record('put_statuses', puts.map((p) => p.status));
    assert.deepEqual(puts.map((p) => p.status), [500, 500, 200]);
    assert.ok(offsets[0] >= 9000 && offsets[0] <= 12500, `first attempt at the debounce (${offsets[0]} ms)`);
    for (const i of [1, 2]) {
      const gap = puts[i].ts - puts[i - 1].doneTs;
      assert.ok(gap >= 4500 && gap <= 6500, `retry ${i} came ${gap} ms after the failed attempt; expected 5 s (RETRY_DELAY_MS)`);
    }
    await waitFor(async () => (await headerStatusIcon(page)) === 'success', { timeout: 3000, what: 'success icon after the third attempt' });
    await page.waitForTimeout(500);
    for (const t of await toasts(page)) seenToasts.add(t);
    const list = [...seenToasts];
    record('toasts', list);
    assert.ok(list.some((t) => t.includes('poging 2/3')), `warning toast for retry 1: ${list}`);
    assert.ok(list.some((t) => t.includes('poging 3/3')), `warning toast for retry 2: ${list}`);
    assert.ok(!list.some((t) => /Automatisch opslaan mislukt/.test(t)), 'no final error toast');
    assert.ok(!list.some((t) => /succesvol/.test(t)), 'success is the header icon, no toast');
    assert.equal(putCalls(rec, nota.id, since).length, 3, 'no fourth attempt');
    assert.ok((await api.getNota(nota.id)).content.includes('Tekst die drie keer wordt opgeslagen.'), 'third attempt reached storage');
  },
};
