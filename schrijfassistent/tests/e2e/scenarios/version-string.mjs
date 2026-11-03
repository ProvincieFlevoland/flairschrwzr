import assert from 'node:assert/strict';
import { openSettings } from '../lib/app.mjs';

/** The version string (build date • version) is visible in the header gear menu: the build-time constant fed from SOFTWARE_VERSION_TAG. */
export default {
  id: 'version-string', title: 'version string visible',
  async run({ page, adapter, env, record }) {
    let text;
    let m;
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openSettings(page);
    text = (await page.locator('.sa-header-settings-version').textContent()).replace(/\s+/g, ' ').trim();
    m = text.match(/(\d{4}-\d{2}-\d{2}) • (\S+)/);
    assert.ok(m, `gear menu shows "Versie: <build date> • <SOFTWARE_VERSION_TAG>"; got: ${text}`);
    if (env.expectedVersion) assert.equal(m[2], env.expectedVersion, 'version equals SOFTWARE_VERSION_TAG of the build');
    else record('version_note', 'E2E_EXPECTED_VERSION not set: the tag value is recorded, not compared');
    record('version_string', m[0]);
    // a stale prebuilt bundle would carry an old build date
    const today = new Date();
    const age = (today - new Date(m[1])) / 86400000;
    record('build_age_days', Math.round(age));
    assert.ok(age < 30, `build date ${m[1]} is older than 30 days: the bundle under test is stale`);
  },
};
