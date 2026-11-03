import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, typeInCell, setSetting, putCalls, agentCalls, sidebarRowIds, sleep, waitFor } from '../lib/app.mjs';

const MARKER = 'Uniek-Merkteken-Van-Gebruiker-A';
const TOKEN_A = 'test-user-token';
const TOKEN_B = 'test-admin-token';

/** `unmount()` without the close sequence, then a mount for another user in the same page.
 *  User A types (the auto-AI countdown, the auto-title timer and the autosave debounce are armed; the debounce PUT and the first agent calls fire together at 10 s) and has agent calls in flight (their answers are delayed
 *  by the test). The container is unmounted and mounted again for user B with another token. Afterwards nothing of A runs: no request carries A's token,
 *  no agent call or PUT for A's nota is sent after the remount, A's in-flight answers are not written into B's cache, B's cache never holds A's text, and B opening the nota finds none of A's suggestions. */
export default {
  id: 'unmount-and-remount', title: 'unmount stops timers and requests; a remount for another user inherits nothing', timeout: 120000,
  async run({ page, context, adapter, api, rec, record, cleanup, env, skip }) {
    const nota = scratchNota('unmount-and-remount', { title: 'Nieuwe Concept Nota', titleManuallySet: false, content: notaHtml({ h3: '<p>Wij verzoeken u dit te accorderen. Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.</p>' }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await context.route(/generate-agent-response/, async (route) => {
      await sleep(8000);
      try { await route.continue(); } catch { /* aborted by the unmount */ }
    });
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await setSetting(page, 'Auto-AI na typen', true);
    await openNota(page, nota.title);
    const tEnd = await typeInCell(page, 'h3', `${MARKER}. Wij verzoeken u dit te accorderen over het voorstel voor een parkeergarage onder het provinciehuis.`);
    // the countdown fires 10 s after the last keystroke: wait until the agent calls of A are on their way (their answers are held back 8 s)
    await waitFor(() => agentCalls(rec, tEnd).length >= 2, { timeout: 15000, what: 'agent calls of user A in flight' });

    const tRemount = Date.now();
    await page.evaluate(async ({ tokenB }) => {
      const el = document.getElementById('sa-container');
      const settings = window.__saHarness.settings;
      await window.SchrijfassistentApp.unmount();
      window.SchrijfassistentApp.mount(el, {
        getToken: () => tokenB,
        user: { id: 'test-remount-b', email: 'b@example.test', name: 'Test B', role: 'user' },
        config: { api_base_url: settings.apiBase, asset_base_url: '/static/apps/schrijfassistent', b1_metrics_doc_url: '' },
        onClose: () => {},
      });
    }, { tokenB: TOKEN_B });
    await page.waitForSelector('#sa-container.sa-root .user-badge', { timeout: 15000 });
    await page.waitForSelector('.nota-list-item', { timeout: 15000 });

    // everything A had armed or in flight would have fired by now (autosave 10 s, auto-title 15 s, the delayed answers 8 s)
    await sleep(20000);
    const after = rec.requests.filter((r) => r.ts >= tRemount && /\/api\/v1\//.test(r.url));
    record('requests_after_remount', after.map((r) => `${r.method} ${new URL(r.url).pathname}`));
    const leaked = after.filter((r) => (r.headers['authorization'] || '') === `Bearer ${TOKEN_A}`);
    assert.equal(leaked.length, 0, 'no request after the remount carries user A\'s token');
    assert.equal(after.filter((r) => (r.headers['authorization'] || '') === `Bearer ${TOKEN_B}`).length > 0, true, 'user B\'s own requests carry B\'s token');
    assert.equal(putCalls(rec, nota.id, tRemount).length, 0, 'no PUT of A\'s nota after the remount (debounce cleared)');
    assert.equal(agentCalls(rec, tRemount).length, 0, 'no agent call after the remount (countdown cleared)');
    assert.equal(rec.api('POST', /generate-nota-title/, tRemount).length, 0, 'no title call after the remount (timer cleared)');

    const dbB = await page.evaluate(() => JSON.parse(localStorage.getItem('gs_nota_db:test-remount-b') || 'null'));
    assert.ok(dbB, 'B has a cache of their own under the B key');
    const text = JSON.stringify(dbB || {});
    assert.equal(text.includes(MARKER), false, 'B\'s cache holds nothing A typed');
    const cachedNota = (dbB?.notas || []).find((n) => n.id === nota.id);
    assert.equal(!!(cachedNota && (cachedNota.chapterFeedbacks || cachedNota.chapterFeedbacksB1 || cachedNota.chapterFeedbacksSpelling)), false, 'A\'s in-flight answers were not written into B\'s session');
    // B opens the nota: the answers that A had in flight did not land in B's session, so no suggestion row or highlight exists
    await openNota(page, nota.title);
    await sleep(500);
    assert.equal((await sidebarRowIds(page)).length, 0, 'no suggestion rows from A\'s answers in B\'s session');
    assert.equal(await page.locator('.suggestion-highlight').count(), 0, 'no highlights from A\'s answers');
  },
};
