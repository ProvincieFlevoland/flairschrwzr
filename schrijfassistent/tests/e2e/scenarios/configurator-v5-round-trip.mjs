import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { STORAGE, expectedBlobsForUpload, fixture } from '../lib/api.mjs';
import { waitFor, sleep, waitNotice, buttonByText } from '../lib/app.mjs';
import { stamp, deleteConfig, listConfigs, waitToast } from '../lib/configs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../../dev/fixtures/config/GS-nota-v5.upload.json');
const byId = (a) => [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)));

/** configuration round trip with the 135,647-byte fixture: import the file, save it to storage under a test id, check the
 *  POST body against the fixture and the blob set against the storage rules, export it, then delete it (active refused, toggle, typed name). */
export default {
  id: 'configurator-v5-round-trip', title: 'configurator: v5 fixture round trip (import, save, export, delete)', timeout: 180000,
  async run({ page, adapter, api, rec, env, record, cleanup }) {
    const rid = `test-rt-${stamp()}`;
    cleanup(() => deleteConfig(api, rid));
    assert.equal(statSync(FIXTURE).size, 135647, 'the fixture is the 135,647-byte upload body');
    const raw = readFileSync(FIXTURE);
    const fx = JSON.parse(raw.toString('utf8'));
    const inner = Object.values(fx)[0];

    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    await page.locator('.config-item-synced').first().waitFor();

    // import the file as it is
    const t0 = Date.now();
    await page.locator('input[type="file"]').setInputFiles({ name: 'GS-nota-v5.upload.json', mimeType: 'application/json', buffer: raw });
    await waitNotice(page, rec, env, /^Configuratie succesvol geïmporteerd!$/, { since: t0 });
    await sleep(400);
    await page.locator('input[class*="title-input"]').waitFor();
    await page.locator('[class*="tab-btn"]').filter({ hasText: /Eigenschappen/i }).first().click();
    const idInput = page.locator('#config-id');
    await idInput.waitFor();
    assert.match(await idInput.inputValue(), /^conf-\d{13}$/, 'the import is selected under a local id');
    // the unique id is the folder of the upload: give it a test id
    await idInput.fill(rid);
    await idInput.blur();

    // save
    const t1 = Date.now();
    await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
    const posts = await waitFor(() => { const p = rec.api('POST', /upload-configuration/, t1); return p.length && p[0].doneTs ? p : null; }, { what: 'POST upload-configuration' });
    assert.equal(posts[0].status, 200);
    const body = JSON.parse(posts[0].postData);
    assert.deepEqual(Object.keys(body), [rid], 'folder key is the id typed in the Uniek ID field');
    const sent = body[rid];
    record('post_bytes', posts[0].postData.length);
    assert.deepEqual(byId(sent.mappen.hoofdstukken), byId(inner.mappen.hoofdstukken), 'chapters travel unchanged');
    assert.equal(sent.mappen.hoofdstukken.length, 15);
    assert.deepEqual(sent.mappen.woordenlijst, inner.mappen.woordenlijst, 'the import keeps the woordenlijst');
    assert.equal(sent.mappen.terminologie.length + sent.mappen.regels.length, inner.mappen.terminologie.length + inner.mappen.regels.length, 'every rule survives');
    assert.deepEqual(sent.b1Guidelines, inner.b1Guidelines, 'b1Guidelines unchanged');
    // the metadata part of the body: name, version, description, tone and the active flag, not just the lists
    assert.equal(sent.name, `${inner.name} (Import)`, 'name = the imported name + " (Import)"');
    assert.equal(sent.templateVersion, inner.templateVersion);
    assert.equal(sent.description, inner.description);
    assert.equal(sent.toneOfVoice, inner.toneOfVoice);
    assert.equal(sent.isActive, inner.isActive === true, 'the active flag follows the file (only a literal true counts)');
    assert.deepEqual(Object.keys(sent).sort(), ['b1Guidelines', 'description', 'isActive', 'mappen', 'name', 'templateVersion', 'toneOfVoice'], 'exactly these top-level fields');
    await waitNotice(page, rec, env, /succesvol opgeslagen/, { since: t1 });

    // blob set on the server equals what the body dictates
    const subs = (await api.get(`${STORAGE}/configurations/${encodeURIComponent(rid)}/subfolders`)).json.subfolders;
    const names = [`${rid}/metadata.json`];
    for (const sub of subs) {
      const data = (await api.get(`${STORAGE}/configurations/${encodeURIComponent(rid)}/${sub}/data`)).json.data;
      data.forEach((d, i) => names.push(`${rid}/${sub}/${d && typeof d === 'object' && d.id ? d.id : i}.json`));
    }
    const expected = expectedBlobsForUpload(body).sort();
    assert.deepEqual(names.sort(), expected, 'blob set equals what the upload body dictates');

    // export of the saved configuration
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exporteer' }).click()]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.id, rid);
    assert.equal(exported.templateGuidelines.length, 15);

    // delete: an active configuration is refused
    const item = page.locator('[class*="config-selection-item"]').filter({ hasText: /\(Import\)/ }).first();
    await item.waitFor();
    const isActive = sent.isActive !== false;
    record('saved_active', isActive);
    const t2 = Date.now();
    if (isActive) {
      await item.locator('button[aria-label="Configuratie verwijderen"]').click();
      await waitToast(page, /nog actief/);
      assert.equal(rec.api('DELETE', /\/configurations\//, t2).length, 0, 'no DELETE for an active configuration');
      await item.locator('button[aria-label="Markeer als inactief"]').click();
      await waitFor(() => rec.api('PATCH', new RegExp(`/configurations/${rid}/metadata`), t2).filter((p) => p.doneTs).length === 1, { what: 'PATCH inactive' });
    }
    // typed name
    const t3 = Date.now();
    await item.locator('button[aria-label="Configuratie verwijderen"]').click();
    const dlg = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
    await dlg.waitFor();
    const confirm = dlg.getByRole('button', { name: /Verwijderen$/ });
    assert.equal(await confirm.isDisabled(), true, 'disabled until the name is typed');
    await dlg.locator('input[type="text"]').fill((await dlg.locator('code').textContent()).trim());
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await waitFor(() => rec.api('DELETE', new RegExp(`/configurations/${rid}`), t3).filter((p) => p.doneTs).length === 1, { what: 'DELETE config' });
    assert.equal(rec.api('DELETE', new RegExp(`/configurations/${rid}`), t3)[0].status, 200);
    assert.equal(new URL(rec.api('DELETE', /\/configurations\//, t3)[0].url).pathname.split('/').pop(), rid, 'the DELETE names exactly the confirmed configuration');
    assert.equal(rec.api('DELETE', /\/configurations\//, t3).length, 1, 'one DELETE');
    assert.ok(!(await listConfigs(api)).some((c) => c.id === rid || c === rid), 'the configuration is gone from the backend');
    assert.equal((await api.get(`${STORAGE}/configurations/${encodeURIComponent(rid)}/metadata`)).status, 404);
    await waitToast(page, /succesvol verwijderd/);
  },
};
