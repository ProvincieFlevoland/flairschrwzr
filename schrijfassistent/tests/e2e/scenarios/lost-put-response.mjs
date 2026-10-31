import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, typeInCell, putCalls, waitFor, toasts, sleep } from '../lib/app.mjs';

const CONFLICT = 'De nota is intussen door iemand anders opgeslagen';
const MINE = 'Tekst waarvan het antwoord op de eerste opslag verloren gaat.';
const NEXT = 'Een vervolgwijziging na het herstel.';

/** the first autosave PUT reaches the backend and is stored, but its response is
 *  dropped (the browser sees a network error, the way a proxy reset or a timeout looks). The retry 5 s later still carries the old base, the backend answers
 *  409, and that 409 is caused by the auteur's own write: the app adopts the stored lastModified as base and resends once. No conflict toast, no conflict
 *  indicator, three PUTs (dropped, 409, 200), the text is stored, and the next autosave carries the lastModified of the last PUT as base. A real conflict
 *  (another client saved) is still reported. */
export default {
  id: 'lost-put-response', title: 'a lost PUT response is not a conflict: adopt and resend once', timeout: 120000,
  async run({ page, context, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('lost-put-response', { title: 'Test lost put' });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);

    let dropped = 0;
    await context.route(new RegExp(`/storage/notas/${nota.id}$`), async (route) => {
      if (route.request().method() === 'PUT' && dropped === 0) {
        dropped += 1;
        await route.fetch();            // the backend stores it ...
        await route.abort('connectionreset');   // ... and the response never arrives
        return;
      }
      await route.continue();
    });

    const tEnd = await typeInCell(page, 'h2', MINE);
    const since = tEnd - 5000;
    const puts = await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length >= 3 && p[2].doneTs ? p : null; }, { timeout: 40000, what: 'three PUTs (dropped, 409, 200)' });
    record('put_statuses', puts.map((p) => p.failed ? 'dropped' : p.status));
    assert.equal(puts[0].failed, true, 'the first response was dropped');
    assert.equal(puts[1].status, 409, 'the retry with the old base is refused');
    assert.equal(puts[1].headers['x-nota-base-modified'], nota.lastModified);
    assert.equal(puts[2].status, 200, 'the resend with the adopted base succeeds');
    const firstBody = JSON.parse(puts[0].postData);
    assert.equal(puts[2].headers['x-nota-base-modified'], firstBody.lastModified, 'the adopted base is the lastModified of our own first write');
    assert.equal(putCalls(rec, nota.id, since).length, 3, 'exactly one resend');
    assert.equal((await toasts(page)).some((t) => t.includes(CONFLICT)), false, 'no conflict toast');
    assert.equal(await page.locator('[data-testid="conflict-indicator"]').count(), 0, 'no conflict indicator');
    assert.ok((await api.getNota(nota.id)).content.includes(MINE), 'the text is stored');

    // the nota is not in conflict afterwards: the next autosave goes out with the last base and succeeds
    const t2 = await typeInCell(page, 'h2', NEXT);
    const since2 = Math.max(t2 - 2000, puts[2].ts + 1);
    const next = await waitFor(() => { const p = putCalls(rec, nota.id, since2); return p.length && p[0].doneTs ? p : null; }, { timeout: 20000, what: 'PUT after the recovery' });
    assert.equal(next[0].status, 200);
    assert.equal(next[0].headers['x-nota-base-modified'], JSON.parse(puts[2].postData).lastModified, 'the base is the lastModified of the previous PUT');
    await sleep(500);
    assert.equal(await page.locator('[data-testid="conflict-indicator"]').count(), 0);
  },
};
