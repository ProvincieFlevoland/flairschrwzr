import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, typeInCell, sleep, waitFor } from '../lib/app.mjs';
import { stamp, configBody, uploadConfig, deleteConfig } from '../lib/configs.mjs';

/** trigger words are literal text end to end, and a string-valued triggerWords (what the configurator saves
 *  after an edit of the rule row) is read as a comma list instead of throwing in the sidebar. */
export default {
  id: 'configurator-rule-triggers', title: 'configuration rules: trigger words are literal, a string value reads as a list', timeout: 120000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const s = stamp();
    const cid = `test-trig-${s}`;
    const rules = [
      { id: 'rt1', category: 'Regels', severity: 'medium', triggerWords: ['(a+)+$', 'a*', '.*', '', '[', '\\'], alternatives: ['x'], explanation: 'literal' },
      { id: 'rt2', category: 'Regels', severity: 'low', triggerWords: 'kaas, ham, ', alternatives: 'brood, boter', explanation: 'string value' },
    ];
    cleanup(() => deleteConfig(api, cid));
    await uploadConfig(api, configBody(cid, { name: cid, isActive: true, mappen: { regels: rules, terminologie: [], woordenlijst: [] } }));
    const nota = scratchNota('configurator-rule-triggers', { configId: cid, configName: cid, content: notaHtml({ h3: '<p>start</p>' }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const t0 = Date.now();
    await typeInCell(page, 'h3', `${'a'.repeat(40)}! en nog a* en .* en kaas, geen ham-sandwich`, { replace: true });
    // the rule cards are not reachable in the sidebar (the Taalsuggesties tab is hidden); the visible effect of a trigger word is the
    // CSS custom highlight "sa-ai-suggestions" on the active cell
    const ranges = () => page.evaluate(() => { const h = CSS.highlights.get('sa-ai-suggestions'); return h ? [...h].map((r) => r.toString()) : []; });
    await waitFor(async () => (await ranges()).length >= 4, { what: 'highlight ranges' });
    const got = [...new Set((await ranges()).map((x) => x.toLowerCase()))].sort();
    record('ranges', got);
    assert.deepEqual(got, ['.*', 'a*', 'ham', 'kaas'], 'only literal occurrences are painted: a*, .*, kaas and ham; no pattern match, no empty entry');
    // the editor answers while the catastrophic string is in the cell
    const rt = await page.evaluate(() => { const t = performance.now(); return new Promise((r) => requestAnimationFrame(() => r(performance.now() - t))); });
    assert.ok(rt < 2000, `the editor stays responsive: ${rt} ms`);
    assert.deepEqual(pageErrors, [], 'no exception from the sidebar (a string triggerWords does not throw)');
    record('elapsed_ms', Date.now() - t0);
  },
};
