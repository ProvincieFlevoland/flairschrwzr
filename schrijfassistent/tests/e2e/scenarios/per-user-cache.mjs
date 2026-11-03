import assert from 'node:assert/strict';
import { localGetJson, setSetting } from '../lib/app.mjs';

/** a second user on the same browser does not see the first user's notas in the cache (`gs_nota_db`
 *  suffixed with the Open WebUI user id). */
export default {
  id: 'per-user-cache', title: 'second user does not see the first user\'s cached notas',
  async run({ page, adapter, api, env, record, cleanup }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.nota-list-item');
    const cached = await page.evaluate(() => (JSON.parse(localStorage.getItem('gs_nota_db') || '{}').notas || []).length);
    record('cache_notas_after_login', cached);

    // user A creates a nota: createNewNota writes A's cache (saveDB) before any sync
    await page.getByRole('button', { name: 'Nieuwe Nota' }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="modal-title"]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'GS-nota v5' }).first().click();
    await dialog.getByRole('button', { name: 'Selecteer & Start' }).click();
    await page.waitForSelector('.editor-cell[data-block-id]');
    const dbA = await localGetJson(page, 'gs_nota_db');
    const notaId = dbA?.notas?.[0]?.id;
    assert.match(String(notaId), /^n\d{13}$/, 'A created a nota');
    cleanup(() => api.deleteNota(notaId));
    const keysA = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gs_nota_db')));
    record('keys_after_user_a', keysA);
    assert.deepEqual(keysA, ['gs_nota_db:test-auteur'], 'A\'s cache lives under the user-suffixed key only (no plain gs_nota_db)');

    // the other per-user keys: the UI settings and the autosave toggle land under the user-suffixed key, never under the plain one
    await setSetting(page, 'Auto-AI na typen', true);
    await setSetting(page, 'Automatisch Opslaan', false);
    await setSetting(page, 'Automatisch Opslaan', true);
    const settingKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /^(gs_ui_settings|gs_autosave_enabled)/.test(k)).sort());
    record('setting_keys_user_a', settingKeys);
    assert.deepEqual(settingKeys, ['gs_autosave_enabled:test-auteur', 'gs_ui_settings:test-auteur'], 'the settings keys carry the user id and there is no plain key');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gs_ui_settings:test-auteur')).autoAi), true);

    // user B in the same browser profile
    await adapter.login(page, { name: 'Test Tweede', role: 'auteur' });
    await page.waitForSelector('.nota-list-item');
    const keysB = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gs_nota_db')).sort());
    record('keys_after_user_b', keysB);
    assert.deepEqual(keysB, ['gs_nota_db:test-auteur', 'gs_nota_db:test-tweede'], 'B got a cache key of their own');
    const dbB = await localGetJson(page, 'gs_nota_db');
    const idsB = (dbB?.notas || []).map((n) => n.id);
    record('cache_notas_user_b', idsB);
    assert.ok(!idsB.includes(notaId), 'B\'s cache does not hold A\'s nota');
    const stillA = await page.evaluate(() => (JSON.parse(localStorage.getItem('gs_nota_db:test-auteur') || '{}').notas || []).map((n) => n.id));
    assert.ok(stillA.includes(notaId), 'A\'s cache still holds A\'s nota');
    // B does not inherit A's settings (a new user starts from the defaults)
    assert.equal(await page.evaluate(() => localStorage.getItem('gs_ui_settings:test-tweede')), null, 'B has no settings key of their own yet');
  },
};
