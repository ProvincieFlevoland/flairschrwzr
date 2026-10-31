import assert from 'node:assert/strict';

/** switch Open WebUI to dark mode -> app colours follow the `.dark` class on <html> (theme hand-off,
 *  9.4 `.dark .sa-root` twins). The bundle reads the class on mount and observes it (hostBridge.js). */
export default {
  id: 'dark-mode', title: 'dark mode follows the host .dark class',
  async run({ page, adapter, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    const colours = () => page.evaluate(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      const fg = (sel) => getComputedStyle(document.querySelector(sel)).color;
      return { root: bg('#sa-container.sa-root'), header: bg('.sa-root .app-header'), text: fg('.sa-root .header-title'), dark: document.documentElement.classList.contains('dark') };
    });
    const light = await colours();
    record('light', light);
    assert.equal(light.dark, false, 'starts in light mode');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForFunction((lightRoot) => getComputedStyle(document.querySelector('#sa-container.sa-root')).backgroundColor !== lightRoot, light.root, { timeout: 5000 });
    const dark = await colours();
    record('dark', dark);
    assert.notEqual(dark.root, light.root, 'app background follows .dark');
    assert.notEqual(dark.header, light.header, 'header background follows .dark');
    assert.notEqual(dark.text, light.text, 'text colour follows .dark');
    // the dark twin of the nota-list hover border must win over the Svelte scoped light rule
    if (await page.locator('.sa-root .nota-list-item').count()) {
      await page.locator('.sa-root .nota-list-item').first().hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sa-root .nota-list-item:hover')).borderTopColor === 'rgb(75, 85, 99)', null, { timeout: 5000 });
      record('dark_hover_border', 'rgb(75, 85, 99)');
      await page.mouse.move(0, 0);
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForFunction((lightRoot) => getComputedStyle(document.querySelector('#sa-container.sa-root')).backgroundColor === lightRoot, light.root, { timeout: 5000 });
    const back = await colours();
    assert.deepEqual({ root: back.root, header: back.header, text: back.text }, { root: light.root, header: light.header, text: light.text }, 'colours return when .dark is removed');
  },
};
