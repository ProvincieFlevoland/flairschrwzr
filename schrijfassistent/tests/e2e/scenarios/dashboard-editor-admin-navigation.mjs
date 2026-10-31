import assert from 'node:assert/strict';
import { openNota, backToDashboard, notaItem, waitView, waitFor } from '../lib/app.mjs';

/** dashboard, open nota, back, admin (as beheerder), back -> each view renders; the editor shows 15 hoofdstuk blocks. */
export default {
  id: 'dashboard-editor-admin-navigation', title: 'dashboard -> editor -> back -> admin -> back',
  async run({ page, adapter, env, rec, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    assert.ok(await page.getByText("Recente GS-Nota's").isVisible(), 'dashboard renders');

    await page.waitForSelector('.nota-list-item', { timeout: 20000 });
    await notaItem(page, 'Parkeergarage provinciehuis — concept').click();
    await page.getByRole('button', { name: 'Bewerk Nota' }).click();
    await waitView(page, '.editor-cell[data-block-id]');
    await page.waitForFunction(() => !!document.querySelector('.editor-cell .cell-content'));
    const cells = await page.locator('.editor-cell[data-block-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-block-id')));
    record('editor_blocks', cells);
    assert.deepEqual(cells, Array.from({ length: 15 }, (_, i) => `block-h${i + 1}`), '15 hoofdstuk blocks, h1..h15');
    await backToDashboard(page);
    assert.ok(await page.getByText("Recente GS-Nota's").isVisible(), 'dashboard renders again');

    // the embedded app has no logout: an Open WebUI admin is a new mount (identityAdapter.js: admin -> beheerder)
    await adapter.login(page, { name: 'Test Beheer', role: 'beheerder' });
    const admin = await waitView(page, '[class*="admin-dashboard"]');
    assert.equal(admin, 'real', 'the configurator is wired');

    assert.ok(await page.getByText('Configuraties').first().isVisible(), 'admin view renders');
    await page.waitForSelector('.config-item-synced', { timeout: 20000 });
    assert.ok((await page.locator('.config-item-synced').count()) >= 1, 'admin lists the synced configuration(s)');

    // the header's "Ga naar nota overzicht" returns to the overview in place; the page, the mounted app and the identity stay.
    await page.evaluate(() => { window.__j5Marker = 'still-here'; });
    assert.equal(await page.getByRole('button', { name: 'Terug' }).count(), 0, 'the configurator sidebar has no "Terug" button any more');
    await page.getByRole('button', { name: 'Ga naar nota overzicht' }).click();
    await page.waitForSelector('.dashboard-layout', { timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__j5Marker), 'still-here', 'no page reload');
    assert.equal(await page.locator('.quick-login-section, #accessPassword').count(), 0, 'no login screen');
    assert.ok((await page.locator('.user-badge').textContent()).includes('Test Beheer'), 'identity kept');
    assert.ok(await page.getByRole('button', { name: 'Beheerdersweergave' }).isVisible(), 'the header offers the configurator again');
    record('admin_back_behaviour', 'the header button returns to the overview: no page reload, mount and identity kept');
  },
};
