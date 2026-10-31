import assert from 'node:assert/strict';
import { setSetting, openSettings, settingSwitch, localGetJson } from '../lib/app.mjs';

/** toggle auto-AI off and reload -> the setting persists (localStorage `gs_ui_settings`, uiStore.js;
 *  the key is suffixed with the Open WebUI user id, storageKeys.js). */
export default {
  id: 'auto-ai-setting-persists', title: 'auto-AI setting persists across a reload',
  async run({ page, adapter, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    const wasOn = await setSetting(page, 'Auto-AI na typen', true);
    assert.equal(wasOn, false, 'default is off (uiStore DEFAULT_SETTINGS.autoAi)');
    await adapter.reloadAndLogin(page, { name: 'Test Auteur', role: 'auteur' });
    await openSettings(page);
    assert.equal(await settingSwitch(page, 'Auto-AI na typen').getAttribute('aria-checked'), 'true', 'on after reload');
    await settingSwitch(page, 'Auto-AI na typen').click();                      // off again
    assert.equal(await settingSwitch(page, 'Auto-AI na typen').getAttribute('aria-checked'), 'false');
    const stored = await localGetJson(page, 'gs_ui_settings');
    record('gs_ui_settings', stored);
    assert.equal(stored.autoAi, false);
    await adapter.reloadAndLogin(page, { name: 'Test Auteur', role: 'auteur' });
    await openSettings(page);
    assert.equal(await settingSwitch(page, 'Auto-AI na typen').getAttribute('aria-checked'), 'false', 'off after reload');
  },
};
