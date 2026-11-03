import assert from 'node:assert/strict';
import { openSettings, settingSwitch, localGetJson } from '../lib/app.mjs';

/** Open the header settings menu and reload -> no chat-mode toggle, uiSettings.chatMode stays false after reload. */
export default {
  id: 'settings-menu', title: 'settings menu: no chat-mode toggle, defaults, chatMode stays false',
  async run({ page, adapter, env, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openSettings(page);
    const labels = await page.locator('label').filter({ has: page.locator('button[role="switch"]') }).evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')));
    record('settings_rows', labels);
    const chat = settingSwitch(page, 'Schrijfassistent (Chat)');
    const present = (await chat.count()) > 0;
    record('chat_mode_toggle_present', present);
    const states = {};
    for (const l of ['Auto-AI na typen', 'Automatisch Opslaan', 'Direct Duidelijk metrics']) states[l] = await settingSwitch(page, l).getAttribute('aria-checked');
    record('switch_states', states);
    assert.deepEqual(states, { 'Auto-AI na typen': 'false', 'Automatisch Opslaan': 'true', 'Direct Duidelijk metrics': 'false' }, 'defaults: uiStore DEFAULT_SETTINGS + autosave enabled');
    assert.equal(present, false, 'the app has no chat-mode toggle');
    const stored = await localGetJson(page, 'gs_ui_settings', null);
    record('gs_ui_settings_before_reload', stored);
    await adapter.reloadAndLogin(page, { name: 'Test Auteur', role: 'auteur' });
    const after = await localGetJson(page, 'gs_ui_settings', { chatMode: false });
    assert.equal(after.chatMode, false, 'chatMode stays false across a reload');
    await openSettings(page);
    assert.equal(await settingSwitch(page, 'Auto-AI na typen').getAttribute('aria-checked'), 'false');
  },
};
