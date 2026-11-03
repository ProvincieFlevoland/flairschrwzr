import assert from 'node:assert/strict';
import { waitView } from '../lib/app.mjs';

/** an Open WebUI admin (role beheerder) lands on the nota overview acting as auteur (scenario header-user-and-role); the
 *  header's "Beheerdersweergave" opens the admin view, where the header offers "Ga naar nota overzicht" (data-action
 *  work-as-author) to return to the dashboard acting as auteur (`actingAsAuthor`). The adapter opens the admin view for a beheerder. */
export default {
  id: 'admin-works-as-auteur', title: 'admin works as auteur',
  async run({ page, adapter, record }) {
    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    record('admin_view', await waitView(page, '[class*="admin-dashboard"]'));
    const control = page.getByRole('button', { name: 'Ga naar nota overzicht' });
    await control.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.dashboard-layout').count(), 0, 'the admin view shows no dashboard');
    await control.click();
    await page.waitForSelector('.dashboard-layout', { timeout: 20000 });
    assert.ok(await page.getByRole('button', { name: 'Nieuwe Nota' }).isVisible(), 'acting as auteur: the author buttons are there');
    const back = page.getByRole('button', { name: 'Beheerdersweergave' });
    assert.ok(await back.isVisible(), 'the header offers the configurator');
    await back.click();
    await waitView(page, '[class*="admin-dashboard"]');
    assert.equal(await page.locator('.dashboard-layout').count(), 0, 'back on the admin view');
    await page.getByRole('button', { name: 'Ga naar nota overzicht' }).waitFor({ state: 'visible' });
    // an auteur never sees either control
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.dashboard-layout');
    assert.equal(await page.getByRole('button', { name: 'Ga naar nota overzicht' }).count(), 0, 'no control for an auteur');
  },
};
