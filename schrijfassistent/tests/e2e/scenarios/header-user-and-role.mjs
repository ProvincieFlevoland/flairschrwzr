import assert from 'node:assert/strict';
import { waitView } from '../lib/app.mjs';

/** Open the app -> the header shows the user name; the Open WebUI role maps to the app role. */
export default {
  id: 'header-user-and-role', title: 'open the app: header shows user name and role',
  async run({ page, adapter, env, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    const badge = (await page.locator('.user-badge').textContent()).replace(/\s+/g, ' ').trim();
    record('badge', badge);
    assert.match(badge, /Test Auteur/);
    // mapping (identityAdapter.js): Open WebUI role `user` -> auteur, `admin` -> beheerder
    assert.match(badge, /\(auteur\)/, 'Open WebUI role user maps to auteur');
    assert.ok(await page.locator('.dashboard-layout').isVisible(), 'an auteur lands on the dashboard');
    // a beheerder lands on the nota overview too, acting as auteur; the header offers the configurator
    {
      // the badge is the close control; a second identity is a new mount; `landing` keeps the view the app lands on
      await adapter.login(page, { name: 'Test Beheer', role: 'beheerder', landing: true });
      const b2 = (await page.locator('.user-badge').textContent()).replace(/\s+/g, ' ').trim();
      assert.match(b2, /Test Beheer/); assert.match(b2, /\(beheerder\)/, 'Open WebUI role admin maps to beheerder');
      assert.ok(await page.locator('.dashboard-layout').isVisible(), 'a beheerder lands on the dashboard');
      assert.equal(await page.getByRole('button', { name: 'Nieuwe Nota' }).count(), 1, 'acting as auteur: the overview is a working one');
      await page.getByRole('button', { name: 'Beheerdersweergave' }).click();
      record('admin_view', await waitView(page, '[class*="admin-dashboard"]'));
      assert.ok(await page.getByText('Configuraties').first().isVisible(), 'the header button opens the configurator');
    }
  },
};
