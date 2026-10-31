import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG_ID, STORAGE, expectedBlobsForUpload } from '../lib/api.mjs';
import { waitFor, sleep, waitNotice, localGetJson, buttonByText } from '../lib/app.mjs';

/** configurator: toggle isActive, add a rule, save, export, import the export -> PATCH observed; blob set after save matches the
 *  storage rules; an import of the export creates a copy with a new id `conf-<timestamp>` (the name gets the suffix " (Import)"), keeping the
 *  woordenlijst of the file. The seeded configuration is restored afterwards. */
export default {
  id: 'configurator-basics', title: 'configurator: isActive PATCH, add rule + save, export, import copy', timeout: 120000,
  async run({ page, adapter, api, rec, env, record, cleanup }) {
    cleanup(() => api.restoreConfig());
    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    const item = page.locator('.config-item-synced').filter({ hasText: CONFIG_ID }).first();
    await item.waitFor();

    // 1. isActive toggle -> PATCH (twice: off, on)
    const t0 = Date.now();
    await item.locator('button[aria-label="Markeer als inactief"]').click();
    await waitFor(() => rec.api('PATCH', /\/configurations\/GS-nota%20v5\/metadata/, t0).filter((p) => p.doneTs).length === 1, { what: 'PATCH isActive:false' });
    let patches = rec.api('PATCH', /\/configurations\/GS-nota%20v5\/metadata/, t0);
    assert.deepEqual(JSON.parse(patches[0].postData), { isActive: false }); assert.equal(patches[0].status, 200);
    assert.equal((await api.get(`${STORAGE}/configurations/${encodeURIComponent(CONFIG_ID)}/metadata`)).json.isActive, false);
    await item.locator('button[aria-label="Markeer als actief"]').click();
    await waitFor(() => rec.api('PATCH', /\/configurations\/GS-nota%20v5\/metadata/, t0).filter((p) => p.doneTs).length === 2, { what: 'PATCH isActive:true' });
    patches = rec.api('PATCH', /\/configurations\/GS-nota%20v5\/metadata/, t0);
    assert.deepEqual(JSON.parse(patches[1].postData), { isActive: true });
    record('patches', patches.map((p) => [p.postData, p.status]));

    // 2. add a rule (Regels tab -> "Regel": AdminDashboard.addRule('B1 Taal')), then save to storage.
    //    addRule pushes into the derived `selectedConfig.rules` and then updateConfig() writes the
    //    `workingConfig` clone back over it, so the rule is lost: no row appears and the save carries no new rule.
    await item.click();
    await page.locator('input[class*="title-input"]').waitFor();
    assert.equal(await page.locator('input[class*="title-input"]').inputValue(), CONFIG_ID);
    // the Woordenlijst tab of a synced configuration shows 0 words although storage holds ["Hallo"]: fetchSubfolderData writes the
    // list into dbStore, but `workingConfig` is a clone taken once per selected id (AdminDashboard.svelte:293-310) and is never refreshed,
    // so the tab renders workingConfig.woordenlijst = undefined and every save sends `woordenlijst: []` (line 685) -> the blob is deleted.
    const tw = Date.now();
    await page.getByRole('button', { name: 'Woordenlijst', exact: true }).click();
    await waitFor(() => rec.api('GET', /\/woordenlijst\/data/, tw).filter((r) => r.doneTs).length, { what: 'woordenlijst data' });
    await sleep(300);
    const wordsShown = (await page.locator('[class*="editor-body"]').textContent()).match(/(\d+) woorden/)?.[1];
    record('woordenlijst_tab_word_count', wordsShown);
    // the stored woordenlijst is merged into the working copy on selection.
    assert.equal(wordsShown, '1', 'the tab shows the stored word');
    await page.getByRole('button', { name: 'Regels', exact: true }).click();
    await buttonByText(page, 'Regel').click();
    await sleep(500);
    const ruleRows = await page.locator('table tbody tr').count();
    record('rule_rows_after_add', ruleRows);
    // the new rule is added to the working copy, so its row appears.
    assert.equal(ruleRows, 1, '"Regel" adds a visible rule row');
    const t1 = Date.now();
    await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
    const posts = await waitFor(() => { const p = rec.api('POST', /upload-configuration/, t1); return p.length && p[0].doneTs ? p : null; }, { what: 'POST upload-configuration' });
    assert.equal(posts[0].status, 200);
    const body = JSON.parse(posts[0].postData);
    const inner = body[CONFIG_ID];
    assert.ok(inner, 'folder key is the config id');
      assert.equal(inner.mappen.regels.length, 1, 'the added rule reaches the save body');
      assert.equal(inner.mappen.regels[0].category, 'B1 Taal');
      assert.deepEqual(inner.mappen.woordenlijst, ['Hallo'], 'the stored woordenlijst is in the save body');
    
    assert.equal(inner.mappen.hoofdstukken.length, 15);
    await waitNotice(page, rec, env, /succesvol opgeslagen/, { since: t1 });   // a toast
    assert.equal(rec.dialogs.length, 0, 'no native dialog in the portal');
    const res = JSON.parse(posts[0].body);
    assert.equal(res.action, 'rebuilt'); assert.equal(res.files_deleted, 17);
    assert.equal(res.files_created, 18, 'metadata + 15 chapters (+ the rule and the woordenlijst blob)');
    // blob set after the save equals the storage rule for this body, reconstructed through the API
    const expected = expectedBlobsForUpload(body).sort();
    const subs = (await api.get(`${STORAGE}/configurations/${encodeURIComponent(CONFIG_ID)}/subfolders`)).json.subfolders;
    const names = [`${CONFIG_ID}/metadata.json`];
    for (const sub of subs) {
      const data = (await api.get(`${STORAGE}/configurations/${encodeURIComponent(CONFIG_ID)}/${sub}/data`)).json.data;
      data.forEach((d, i) => names.push(`${CONFIG_ID}/${sub}/${d && typeof d === 'object' && d.id ? d.id : i}.json`));
    }
    record('blob_set_after_save', names.sort());
    assert.deepEqual(names.sort(), expected, 'blob set equals what the upload body dictates');
    assert.deepEqual(subs.sort(), ['hoofdstukken', 'regels', 'woordenlijst'], 'woordenlijst and the new rule are stored');

    // 3. export -> the flat selectedConfig JSON
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exporteer' }).click()]);
    assert.equal(download.suggestedFilename(), 'GS-nota_v5_config.json');
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    record('export_keys', Object.keys(exported).sort());
    assert.equal(exported.id, CONFIG_ID); assert.equal(exported.name, CONFIG_ID);
    record('export_woordenlijst', exported.woordenlijst);   // from dbStore (in-memory copy of the tab load), not from what was just saved
 assert.equal(exported.rules.length, 1, 'the added rule is in the export'); assert.deepEqual(exported.woordenlijst, ['Hallo']); 
    assert.equal(exported.templateGuidelines.length, 15);
    assert.ok(exported.b1Guidelines !== undefined, 'b1Guidelines travels with the export');

    // 4. import the export -> a local copy: new id, " (Import)", no woordenlijst
    const before = Date.now();
    await page.locator('input[type="file"]').setInputFiles({ name: 'GS-nota_v5_config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await waitNotice(page, rec, env, /^Configuratie succesvol geïmporteerd!$/, { since: before });
    await sleep(300);
    const configs = (await localGetJson(page, 'gs_nota_db')).configurations;
    const imported = configs.find((c) => c.name === `${CONFIG_ID} (Import)`);
    assert.ok(imported, `imported copy present: ${configs.map((c) => c.id + '/' + c.name)}`);
    record('imported', { id: imported.id, name: imported.name, keys: Object.keys(imported).sort() });
    assert.match(imported.id, /^conf-\d{13}$/);
    assert.ok(Number(imported.id.slice(5)) >= before - 1000, 'id is conf-<Date.now()>');
    assert.equal(imported.name, `${CONFIG_ID} (Import)`);
    assert.deepEqual(imported.woordenlijst, ['Hallo'], 'the woordenlijst of the file is kept by the import');
    for (const k of ['templateGuidelines', 'rules', 'b1Guidelines', 'templateVersion', 'description', 'toneOfVoice', 'isActive']) assert.deepEqual(imported[k], exported[k], `${k} equal to the export`);
    assert.ok(await page.locator('[class*="config-item-local"]').filter({ hasText: `${CONFIG_ID} (Import)` }).first().isVisible(), 'listed under lokale configuraties');
    assert.equal(await page.locator('input[class*="title-input"]').inputValue(), `${CONFIG_ID} (Import)`, 'the import is selected');

  },
};
