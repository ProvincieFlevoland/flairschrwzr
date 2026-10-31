import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { SA_DIR } from '../lib/env.mjs';
import { openNota, setSetting, selectTab, sleep } from '../lib/app.mjs';

const TEXT = 'Het huis wordt gebouwd door de provincie. Derhalve is het helder. Wij vragen u dit goed te keuren.';

/** Direct Duidelijk tab with metrics on -> panel values equal calculateB1ParameterSnapshot for the same text.
 *  Oracle: the frontend's own `analysis.js` / `b1Guidelines.js`, the same functions the node tests pin. */
export default {
  id: 'b1-metrics-panel', title: 'Direct Duidelijk metrics panel equals calculateB1ParameterSnapshot',
  async run({ page, adapter, api, record, cleanup }) {
    const utils = path.join(SA_DIR, 'frontend/src/lib/utils');
    const { calculateB1ParameterSnapshot, setB1Lexicons } = await import(pathToFileURL(path.join(utils, 'analysis.js')).href);
    // the app loads the three lexicons on first use of the tab; the oracle reads the same files from the source tree
    const lexicon = (kind) => JSON.parse(readFileSync(path.join(SA_DIR, 'frontend/src/lib/data', `b1-lexicon-${kind}.json`), 'utf8'));
    setB1Lexicons({ jargon: lexicon('jargon'), formal: lexicon('formal'), cohesion: lexicon('cohesion') });
    const { mergeB1Guidelines, DD_VISIBLE_METRICS } = await import(pathToFileURL(path.join(utils, 'b1Guidelines.js')).href);
    const snap = calculateB1ParameterSnapshot(TEXT);
    const metrics = mergeB1Guidelines(null).metrics;
    const expected = Object.fromEntries(DD_VISIBLE_METRICS.map((k) => [metrics[k].label, formatChip(k, snap[k])]));
    record('expected_chips', expected);

    const nota = scratchNota('b1-metrics-panel', { content: notaHtml({ h2: `<p>${TEXT}</p>` }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await setSetting(page, 'Direct Duidelijk metrics', true);
    await openNota(page, nota.title);
    await page.locator('button[aria-label^="Blok: Beslispunten"]').click();   // active block without focusing the editor
    await selectTab(page, 'b1');
    const panel = page.locator('[class*="b1-metrics-panel"]').first();   // the prefixed module classes make the substring match every child too: the outermost is first
    await panel.waitFor();
    // the three lexicons are fetched on the first use of this tab; the chips appear once they are in
    await panel.locator('[class*="b1-chip"]').first().waitFor();
    await sleep(200);
    const chips = await panel.locator('[class*="b1-chip"]:not([class*="b1-chip--info"])').evaluateAll((els) => Object.fromEntries(els.map((el) => [el.querySelector('[class*="chip-label"]')?.textContent.trim(), el.querySelector('[class*="chip-value"]')?.textContent.trim()])));
    record('panel_chips', chips);
      const fetched = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/lexicons\/b1-lexicon-(jargon|formal|cohesion)\.[0-9a-f]{12}\.json/.test(e.name)).length);
      record('lexicon_requests', fetched);
      assert.equal(fetched, 3, 'the three lexicons are fetched on the first use of the tab');
    
    assert.deepEqual(chips, expected, 'chip label -> value equals the oracle snapshot (DD_VISIBLE_METRICS)');
    const words = await panel.locator('[class*="b1-wordcount"]').textContent();
    assert.equal(parseInt(words, 10), snap.wordCount, 'word count');
    assert.ok((await panel.textContent()).includes('Direct Duidelijk (indicatief)'));
    // off again: the panel disappears (setting persisted in gs_ui_settings)
    await setSetting(page, 'Direct Duidelijk metrics', false);
    assert.equal(await panel.count(), 0);
  },
};

/** B1MetricsPanel.formatChipValue + formatSuffix */
function formatChip(key, raw) {
  let v;
  if (raw == null || raw === '') v = '—';
  else if (key === 'heldereZinnenScore') v = String(Math.round(Number(raw)));
  else v = String(raw);
  return v + (key === 'passiveSentencePercent' || key === 'activeVoicePercent' ? '%' : '');
}
