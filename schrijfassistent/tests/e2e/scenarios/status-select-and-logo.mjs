import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, putCalls, waitFor } from '../lib/app.mjs';

/** the status select of an auteur changes the nota status and the
 *  autosave persists it (WIP -> Final-draft -> Final), and the Flevoland logo of the header loads (a 200 image of nonzero width,
 *  from the app's own asset path). */
export default {
  id: 'status-select-and-logo', title: 'status select persists through autosave; the header logo loads', timeout: 90000,
  async run({ page, adapter, api, rec, record, cleanup, env }) {
    const a = scratchNota('status-select-and-logo', { title: 'Test A', status: 'WIP' });
    await api.putNota(a);
    cleanup(() => api.deleteNota(a.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, a.title);

    // the logo
    const logo = page.locator('img[alt="Flevoland Logo"]').first();
    await logo.waitFor({ state: 'visible', timeout: 10000 });
    const loaded = await logo.evaluate((img) => ({ done: img.complete, w: img.naturalWidth, src: img.currentSrc }));
    record('logo', loaded);
    assert.ok(loaded.done && loaded.w > 0, 'the logo image decoded');
    assert.match(loaded.src, /\/static\/apps\/schrijfassistent\/logo_flevoland\.png$|\/logo_flevoland\.png$/, 'served from the app asset path');

    // status select, two changes, each persisted by the debounce
    const select = page.locator('select.role-select').first();
    for (const status of ['Final-draft', 'Final']) {
      const t = Date.now();
      await select.selectOption(status);
      const put = await waitFor(() => { const p = putCalls(rec, a.id, t - 100); return p.length && p[0].doneTs ? p : null; }, { timeout: 20000, what: `PUT after status ${status}` });
      assert.equal(put[0].status, 200);
      assert.equal(JSON.parse(put[0].postData).status, status, `the saved nota carries status ${status}`);
      const stored = await api.getNota(a.id);
      assert.equal(stored.status, status, 'the stored nota carries the new status');
      record(`put_after_${status}_ms`, put[0].ts - t);
    }
  },
};
