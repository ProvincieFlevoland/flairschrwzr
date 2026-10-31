import assert from 'node:assert/strict';

/** with the network log on, no request goes to unpkg.com or fonts.googleapis.com. 
 *  app.html loads Phosphor icons from unpkg and Inter from Google Fonts (frontend/src/app.html:9-14); recorded, then skipped. */
export default {
  id: 'no-third-party-requests', title: 'no third-party requests (unpkg, Google Fonts)',
  async run({ page, adapter, env, rec, record }) {
    await adapter.open(page, { gate: false });
    await page.waitForTimeout(500);
    const hosts = [...new Set(rec.external.map((u) => new URL(u).host))].sort();
    record('external_hosts_requested', hosts);
    assert.deepEqual(hosts.filter((h) => /unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(h)), [], 'embedded bundle must not load unpkg / Google Fonts');
  },
};
