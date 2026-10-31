import assert from 'node:assert/strict';
import { scratchNota, notaHtml, fixture, STORAGE } from '../lib/api.mjs';
import { openNota, setSetting, selectTab, sleep, waitFor } from '../lib/app.mjs';

const TEXT = 'Het huis wordt gebouwd door de provincie. Wij vragen u dit goed te keuren.';
const SOURCES = [
  { label: 'Veilig https', url: 'https://example.nl/richtlijn' },
  { label: 'Veilig mailto', url: 'mailto:taal@flevoland.nl' },
  { label: 'Gevaarlijk javascript', url: 'javascript:window.__pwned=(window.__pwned||[]).concat("js")' },
  { label: 'Gevaarlijk data', url: 'data:text/html,<script>window.__pwned=1</script>' },
  { label: 'Onveilig http', url: 'http://example.nl/oud' },
  { label: 'Zonder url' },
];

/** admin-configured reference links (`b1Guidelines` sources of the configuration, shown in the "Uitleg & bronnen"
 *  drawer of the Direct Duidelijk panel) become an anchor only for https and mailto; a javascript:, data: or http: URL is shown as plain text and a click
 *  runs nothing. The configuration is a copy of the v5 upload under its own id, saved through the API with hostile sources. */
export default {
  id: 'b1-reference-links', title: 'B1 metrics panel: reference links need https or mailto',
  async run({ page, adapter, api, rec, record, cleanup }) {
    // a copy of the v5 configuration under its own id, with hostile b1Guidelines sources (what an admin could have saved); removed afterwards
    const base = fixture('config/GS-nota-v5.upload.json');
    const cfgId = `test-j21b-${Date.now()}`;
    const body = { [cfgId]: { ...Object.values(base)[0], name: cfgId, b1Guidelines: { globalSources: SOURCES, metrics: { activeVoicePercent: { sources: SOURCES } } } } };
    const up = await api.post(`${STORAGE}/upload-configuration`, body);
    assert.ok(up.ok, `upload of the test configuration: ${up.status} ${up.text}`);
    cleanup(() => api.delete(`${STORAGE}/configurations/${encodeURIComponent(cfgId)}`));
    const nota = scratchNota('b1-reference-links', { configId: cfgId, configName: cfgId, content: notaHtml({ h2: `<p>${TEXT}</p>` }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    // the page loads the configurations one after the other; a nota opened before this one has been read has no b1Guidelines yet
    // (a leftover configuration in the container made this flake once), so wait for the last request of its load
    await waitFor(() => rec.api('GET', new RegExp(`/configurations/${cfgId}/hoofdstukken/data`)).some((r) => r.doneTs), { timeout: 20000, what: 'the test configuration is loaded' });
    await setSetting(page, 'Direct Duidelijk metrics', true);
    await openNota(page, nota.title);
    await page.locator('button[aria-label^="Blok: Beslispunten"]').click();
    await selectTab(page, 'b1');
    const panel = page.locator('[class*="b1-metrics-panel"]').first();
    await panel.waitFor();
    await page.getByRole('button', { name: /Uitleg & bronnen/ }).click();
    await sleep(300);
    const shown = await panel.evaluate((root) => ({
      anchors: [...root.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
      text: root.textContent,
    }));
    record('anchors', shown.anchors);
    const bySource = (label) => shown.anchors.filter((a) => a.text === label);
    assert.ok(bySource('Veilig https').length >= 1, 'the https link is an anchor');
    assert.equal(bySource('Veilig https')[0].href, 'https://example.nl/richtlijn');
    assert.ok(bySource('Veilig mailto').length >= 1, 'the mailto link is an anchor');
    for (const label of ['Gevaarlijk javascript', 'Gevaarlijk data', 'Onveilig http']) {
      assert.equal(bySource(label).length, 0, `${label} is not an anchor`);
      assert.ok(shown.text.includes(label), `${label} is still shown, as text`);
    }
    for (const a of shown.anchors) assert.ok(/^(https:|mailto:|https?:\/\/)/.test(a.href) || a.href === '', `no anchor with a foreign scheme: ${a.href}`);
    assert.deepEqual(shown.anchors.filter((a) => /^(javascript|data):/i.test(a.href)), [], 'no javascript: or data: anchor anywhere in the panel');
    assert.equal(await page.evaluate(() => window.__pwned ?? null), null, 'nothing executed');
  },
};
