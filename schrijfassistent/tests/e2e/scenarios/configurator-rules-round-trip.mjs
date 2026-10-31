import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../lib/api.mjs';
import { waitFor, sleep, waitNotice } from '../lib/app.mjs';
import { stamp, uploadConfig, deleteConfig, configItem } from '../lib/configs.mjs';

const byId = (a) => [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)));

/** the rules of a configuration make the whole round trip, with a configuration that HAS rules (the v5 fixture has none, so
 *  "every rule survives" was 0 = 0): seeded through the API (3 terminologie, 4 regels), shown in the Terminologie and Regels tabs,
 *  saved unedited (the body carries the same two lists), exported (one `rules` list of 7), imported (a copy with the 7 rules) and
 *  saved again under another id (split back into 3 and 4). Both targets. */
export default {
  id: 'configurator-rules-round-trip', title: 'configurator: terminologie and regels survive load, save, export, import and save', timeout: 120000,
  async run({ page, adapter, api, rec, env, record, cleanup }) {
    const s = stamp();
    const id1 = `test-rules-${s}`, id2 = `test-rules-copy-${s}`;
    cleanup(() => deleteConfig(api, id1)); cleanup(() => deleteConfig(api, id2));
    const fx = fixture('config/GS-nota-rules.upload.json');
    const inner = Object.values(fx)[0];
    assert.equal(inner.mappen.terminologie.length, 3); assert.equal(inner.mappen.regels.length, 4);
    await uploadConfig(api, { [id1]: inner });

    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    const item = configItem(page, 'GS-nota rules');
    await item.waitFor();
    // the page-level load of the configurations reads this one last
    await waitFor(() => rec.api('GET', new RegExp(`/configurations/${id1}/regels/data`)).some((r) => r.doneTs), { timeout: 20000, what: 'the regels of the configuration are loaded' });
    await sleep(300);
    await item.click();
    await page.locator('input[class*="title-input"]').waitFor();
    const tab = (re) => page.locator('[class*="tab-btn"]').filter({ hasText: re }).first();
    const rows = async (n) => { await waitFor(async () => (await page.locator('table tbody tr').count()) === n, { timeout: 8000, what: `${n} rows` }).catch(() => null); return page.locator('table tbody tr').count(); };
    await tab(/^\s*Terminologie/i).click();
    const termRows = await rows(3);
    await tab(/^\s*Regels/i).click();
    const ruleRows = await rows(4);
    record('rows', { termRows, ruleRows });
    assert.equal(termRows, 3, 'three terminologie rows'); assert.equal(ruleRows, 4, 'four regel rows');

    // save unedited
    const t1 = Date.now();
    await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
    const posts = await waitFor(() => { const p = rec.api('POST', /upload-configuration/, t1); return p.length && p[0].doneTs ? p : null; }, { what: 'POST' });
    const body = JSON.parse(posts[0].postData)[id1];
    assert.deepEqual(byId(body.mappen.terminologie), byId(inner.mappen.terminologie), 'terminologie travels unchanged');
    assert.deepEqual(byId(body.mappen.regels), byId(inner.mappen.regels), 'regels travel unchanged');
    assert.deepEqual(byId(body.mappen.hoofdstukken), byId(inner.mappen.hoofdstukken));
    await waitNotice(page, rec, env, /succesvol opgeslagen/, { since: t1 });
    const stored = (await api.get(`/api/v1/storage/configurations/${encodeURIComponent(id1)}/regels/data`)).json.data;
    assert.deepEqual(byId(stored), byId(inner.mappen.regels), 'the regel blobs hold the same rules');

    // export: one rules list
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exporteer' }).click()]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.rules.length, 7, 'terminologie and regels are one list in the export');
    assert.deepEqual(byId(exported.rules), byId([...inner.mappen.terminologie, ...inner.mappen.regels]));

    // import it again: a copy with the same 7 rules, saved under another id it splits back
    const t2 = Date.now();
    await page.locator('input[type="file"]').setInputFiles({ name: 'rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await waitNotice(page, rec, env, /^Configuratie succesvol geïmporteerd!$/, { since: t2 });
    await sleep(300);
    await tab(/Eigenschappen/i).click();
    const idInput = page.locator('#config-id');
    await idInput.fill(id2); await idInput.blur();
    const t3 = Date.now();
    await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
    const posts2 = await waitFor(() => { const p = rec.api('POST', /upload-configuration/, t3); return p.length && p[0].doneTs ? p : null; }, { what: 'POST 2' });
    const copy = JSON.parse(posts2[0].postData)[id2];
    assert.deepEqual(byId(copy.mappen.terminologie), byId(inner.mappen.terminologie), 'the import kept the terminologie');
    assert.deepEqual(byId(copy.mappen.regels), byId(inner.mappen.regels), 'the import kept the regels');
    assert.deepEqual(copy.mappen.woordenlijst, inner.mappen.woordenlijst, 'the import keeps the woordenlijst');
    assert.equal(copy.name, 'GS-nota rules (Import)');
  },
};
