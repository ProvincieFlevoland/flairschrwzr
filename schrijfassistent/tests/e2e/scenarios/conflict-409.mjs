import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, backToDashboard, typeInCell, putCalls, waitFor, headerStatusIcon, toasts, cellText, localGetJson, sleep } from '../lib/app.mjs';

const closeDialog = (page) => page.locator('[role="dialog"][aria-labelledby="close-modal-title"]');

const CONFLICT = 'De nota is intussen door iemand anders opgeslagen';
const MINE = 'Mijn lokale wijziging na de botsing.';
const MORE = 'Nog een wijziging terwijl de botsing open staat.';
const AFTER = 'Een wijziging na het opnieuw laden.';

/** Conflict (409), UI part: the embedded app loads a nota, another client saves a newer version, the auteur edits.
 *  The debounced autosave carries X-Nota-Base-Modified = the lastModified the list loaded, the backend answers 409, the app shows ONE conflict
 *  toast and the error icon, does not retry (no second PUT after the 5 s retry delay), does not send the nota again on the next edits and does
 *  not repeat the toast, keeps the typed text in the editor, in the per-user cache and in a conflict copy, and leaves the other client's version
 *  on the server. After the list is reloaded ("Terug naar Overzicht") the nota shows the stored version and the next autosave carries the new
 *  base and succeeds. */
export default {
  id: 'conflict-409', title: 'conflict: 409 toast, no retry, local text kept, reload recovers', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('conflict-409', { title: 'Test eigen' });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);

    // another client saves a newer version (no header: last-write-wins on the backend)
    const other = { ...nota, title: 'Test extern', lastModified: new Date(Date.now() + 5000).toISOString() };
    await api.putNota(other);

    // 1. the auteur edits: the debounced autosave is refused
    const tEnd = await typeInCell(page, 'h2', MINE);
    const since = tEnd - 5000;
    const first = await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length && p[0].doneTs ? p : null; }, { timeout: 16000, what: 'debounced PUT' });
    record('conflict_put_offset_ms', first[0].ts - tEnd);
    assert.equal(first[0].headers['x-nota-base-modified'], nota.lastModified, 'the PUT carries the lastModified the list was loaded with');
    assert.equal(first[0].status, 409);
    const detail = JSON.parse(first[0].body).detail;
    assert.equal(detail.error, 'conflict');
    assert.equal(detail.stored_last_modified, other.lastModified);
    assert.equal(detail.base_last_modified, nota.lastModified);
    await waitFor(async () => (await toasts(page)).some((t) => t.includes(CONFLICT)), { timeout: 3000, what: 'conflict toast' });
    assert.equal((await toasts(page)).filter((t) => t.includes(CONFLICT)).length, 1, 'one conflict toast');
    assert.equal(await headerStatusIcon(page), 'error', 'the status icon shows the failed save');

    // 2. no retry: the retry delay of is 5 s
    await sleep(6500);
    assert.equal(putCalls(rec, nota.id, since).length, 1, 'a 409 is not retried (one PUT after the 5 s retry delay)');
    assert.equal((await toasts(page)).some((t) => /poging|Automatisch opslaan mislukt/.test(t)), false, 'no retry or generic failure toast');

    // 3. keep typing: the next autosave ticks send nothing and say nothing
    const tEnd2 = await typeInCell(page, 'h2', MORE);
    await sleep(11500);
    assert.equal(putCalls(rec, nota.id, since).length, 1, 'the nota in conflict is not sent again');
    assert.equal((await toasts(page)).some((t) => t.includes(CONFLICT)), false, 'the conflict toast is not repeated');
    record('puts_during_conflict', putCalls(rec, nota.id, since).length);

    // 4. the local version is kept: editor, per-user cache, conflict copy; the server keeps the other client's version
    assert.equal(await cellText(page, 'h2'), MORE);
    const db = await localGetJson(page, 'gs_nota_db');
    const cached = (db.notas || []).find((n) => n.id === nota.id);
    assert.ok(cached && cached.content.includes(MORE), 'the per-user cache holds the latest local text');
    const copies = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('gs_nota_conflict:')));
    record('conflict_copy_keys', copies.map(([k]) => k));
    assert.equal(copies.length, 1, 'one conflict copy under gs_nota_conflict:<user>:<nota>');
    const uid = await page.evaluate(() => window.__saHarness?.settings?.user?.id);
    if (uid) assert.equal(copies[0][0], `gs_nota_conflict:${uid}:${nota.id}`, 'exact key shape');
    else assert.ok(copies[0][0].endsWith(`:${nota.id}`) && copies[0][0].split(':').length >= 3, `key shape: ${copies[0][0]}`);
    assert.ok(JSON.parse(copies[0][1]).content.includes(MINE), 'the conflict copy holds the text of the refused save');
    const stored = await api.getNota(nota.id);
    assert.equal(stored.title, 'Test extern');
    assert.equal(stored.content.includes(MINE) || stored.content.includes(MORE), false, 'the server still has the other client\'s version');

    // 4b. the state does not fade with the toast. The indicator is still there ~20 s after the refusal, the generic "lokaal opgeslagen" text was never
    // shown, "Kopieer mijn versie" puts the plain text of the REFUSED version on the clipboard, and closing asks first.
    assert.equal(await page.locator('[data-testid="conflict-indicator"]').isVisible(), true, 'a steady indicator while saving is suspended');
    assert.equal((await toasts(page)).some((t) => t.includes('lokaal opgeslagen')), false, 'no "lokaal opgeslagen" claim during a conflict');
    await page.locator('[data-testid="conflict-copy"]').click();
    await waitFor(async () => (await toasts(page)).some((t) => t.includes('gekopieerd')), { timeout: 3000, what: 'copy toast' });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.includes(MINE), 'the clipboard holds the text of the refused version');
    assert.equal(clip.includes(MORE), false, 'not the later edits (the refused version is the one that was sent)');
    await page.locator('.user-badge').click();
    await closeDialog(page).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('[data-testid="close-discard"]').count(), 1, 'closing a conflicted nota asks and offers "Sluiten zonder opslaan"');
    assert.equal(await page.locator('[data-testid="close-confirm"]').count(), 0, 'there is no "Opslaan en sluiten" while saving is suspended');
    await closeDialog(page).getByRole('button', { name: 'Annuleren' }).click();
    await closeDialog(page).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#sa-container').count(), 1, 'cancel keeps the app open');

    // 5. recovery: reload the list, open the nota again -> the stored version, and the next autosave succeeds with the new base
    await backToDashboard(page);
    await openNota(page, other.title);
    assert.equal((await cellText(page, 'h2')).includes(MORE), false, 'the reloaded nota shows the stored version');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gs_nota_conflict:')).length), 0, 'the conflict copy is removed when the nota is loaded again');
    assert.equal(await page.locator('[data-testid="conflict-indicator"]').count(), 0, 'the indicator is gone after the reload');
    const t3 = await typeInCell(page, 'h2', AFTER);
    const since3 = t3 - 5000;
    const ok = await waitFor(() => { const p = putCalls(rec, nota.id, since3); return p.length && p[0].doneTs ? p : null; }, { timeout: 16000, what: 'PUT after the reload' });
    assert.equal(ok[0].headers['x-nota-base-modified'], other.lastModified, 'the new base is the stored lastModified');
    assert.equal(ok[0].status, 200);
    assert.ok((await api.getNota(nota.id)).content.includes(AFTER));
  },
};
