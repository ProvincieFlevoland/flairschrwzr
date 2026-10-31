import assert from 'node:assert/strict';

/** while the Phosphor font is a placeholder (and after it is vendored) no control of the
 *  full-screen app is blank, and the user can close the app: every icon-only button has an accessible name and a drawn
 *  glyph, the close control is visible, and clicking it removes #sa-container through onClose -> unmount. */
export default {
  id: 'no-blank-controls', title: 'no blank controls; the app can be closed',
  async run({ page, adapter, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.dashboard-layout');
    const blank = await page.evaluate(() => {
      const out = [];
      for (const b of document.querySelectorAll('#sa-container button, #sa-container [role="button"]')) {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const text = (b.textContent || '').replace(/\s+/g, '');
        const name = b.getAttribute('aria-label') || b.getAttribute('title') || '';
        const icon = b.querySelector('[class*="ph-"]');
        const glyph = icon ? getComputedStyle(icon, '::before').content : '';
        const drawn = icon && glyph && glyph !== 'none' && glyph !== '""' && glyph !== "''";
        if (!text && !name) out.push({ what: 'no name', html: b.outerHTML.slice(0, 120) });
        if (!text && !drawn) out.push({ what: 'no visible glyph or text', html: b.outerHTML.slice(0, 120) });
      }
      return out;
    });
    record('blank_controls', blank);
    assert.deepEqual(blank, [], 'every visible icon-only control has an accessible name and a drawn glyph');
    const badge = page.locator('.user-badge');
    assert.ok(await badge.isVisible(), 'the close control (user badge) is visible');
    assert.match((await badge.getAttribute('aria-label')) || '', /sluiten/i);
    const before = await page.evaluate(() => window.__saHarness?.closedCount ?? 0);
    await badge.click();
    await page.waitForFunction(() => !document.getElementById('sa-container'), null, { timeout: 10000 });
    const after = await page.evaluate(() => window.__saHarness?.closedCount ?? 0);
    assert.equal(after, before + 1, 'onClose reached the host once');
    // the settings gear also has its name (checked above) and the host page is usable again
    assert.equal(await page.locator('#sa-container').count(), 0, 'container removed');
  },
};
