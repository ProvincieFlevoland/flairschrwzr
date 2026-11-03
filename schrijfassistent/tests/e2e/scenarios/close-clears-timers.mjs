import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, putCalls, waitFor, sleep, setSetting, typeInCell } from '../lib/app.mjs';

const TEXT = 'Parkeergarage onder het provinciehuis bouwen voor bezoekers en medewerkers.';
const closeDialog = (page) => page.locator('[role="dialog"][aria-labelledby="close-modal-title"]');

/** the close sequence clears the auto-AI countdown and the auto-title timer BEFORE the awaited
 *  save. The first PUT of the close is held back for 12 s, so the app's own 10 s timeout aborts it and the retry (5 s later, not held) saves:
 *  a close that takes about 16 s. The 10 s auto-AI countdown and the 15 s auto-title timer armed by the typing would fire inside that window if
 *  they were cleared after the save. Asserts: the first attempt failed after the timeout, the retry succeeded, no agent call and no title call
 *  happened between the typing and the removal of the container, and the container goes only after the successful PUT. */
export default {
  id: 'close-clears-timers', title: 'close clears the timers before a slow save', timeout: 120000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('close-clears-timers', { title: 'Nieuwe Concept Nota', titleManuallySet: false });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await setSetting(page, 'Auto-AI na typen', true);
    await openNota(page, nota.title);
    let held = 0;
    await page.route(new RegExp(`/storage/notas/${nota.id}(\\?|$)`), async (route) => {
      if (route.request().method() === 'PUT' && held++ === 0) await sleep(12000);
      await route.continue().catch(() => {});      // the first request was aborted by the app's 10 s timeout meanwhile
    });
    const tEnd = await typeInCell(page, 'h1', TEXT);
    await page.locator('.user-badge').click();
    await closeDialog(page).waitFor({ state: 'visible', timeout: 5000 });
    await closeDialog(page).getByRole('button', { name: 'Opslaan en sluiten' }).click();
    const puts = await waitFor(() => { const p = putCalls(rec, nota.id, tEnd - 1000); return p.length >= 2 && p.some((x) => x.status === 200 && x.doneTs) ? p : null; }, { timeout: 40000, what: 'the retried PUT of the close' });
    const [firstTry, retry] = puts;
    const heldMs = firstTry.doneTs - firstTry.ts;
    record('first_put_held_ms', heldMs);
    assert.ok(heldMs >= 9500, `the first PUT was held for ${heldMs} ms, until the app's 10 s timeout, longer than the 10 s auto-AI countdown minus the typing delay`);
    assert.ok(firstTry.failed || firstTry.status !== 200, 'the first attempt did not succeed');
    assert.equal(retry.status, 200, 'the retry saved');
    await page.waitForSelector('#sa-container', { state: 'detached', timeout: 15000 });
    const closedAt = Date.now();
    assert.ok(retry.doneTs <= closedAt + 50, 'the container is removed after the save');
    // nothing armed by the typing fired while the save was in flight (10 s countdown, 15 s title timer), nor in the seconds after
    await sleep(5000);
    const fired = rec.requests.filter((r) => r.ts > tEnd && /generate-agent-response|generate-nota-title/.test(r.url));
    record('agent_or_title_calls', fired.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).searchParams.get('assignment') ? ' ' + new URL(r.url).searchParams.get('assignment') : ''}`));
    assert.deepEqual(fired, [], 'no agent call and no title call between the typing and the end of the close');
    assert.equal(putCalls(rec, nota.id, tEnd - 1000).length, 2, 'the held attempt and its retry, nothing else');
  },
};
