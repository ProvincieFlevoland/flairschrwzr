import assert from 'node:assert/strict';
import { waitFor, sleep, localGetJson } from '../lib/app.mjs';
import { waitToast } from '../lib/configs.mjs';

const BAD = [
  ['null', 'null', /JSON-object/],
  ['lijst', '[]', /JSON-object/],
  ['tekst', '"hallo"', /JSON-object/],
  ['hoofdstukken als tekst', '{"templateGuidelines":"x"}', /moet een lijst zijn/],
  ['null als hoofdstuk', '[null]', /JSON-object/],
  ['regels als tekst', '{"rules":"abc","templateGuidelines":[]}', /moet een lijst zijn/],
  ['geen JSON', '{niet json', /Fout bij het importeren/],
  // the item ids become file names; a path-like id is refused at the import, before it can reach a save
  ['hoofdstuk-id met ../', '{"templateGuidelines":[{"id":"../../notas/n1","titel":"x"}]}', /het item-id "\.\.\/\.\.\/notas\/n1"/],
  ['hoofdstuk-id met ?', '{"templateGuidelines":[{"id":"h1?x=1","titel":"x"}]}', /bevat een \?, # of %/],
  ['regel-id met #', '{"templateGuidelines":[],"rules":[{"id":"r#1","category":"Terminologie"}]}', /bevat een \?, # of %/],
  ['regel-id met backslash', '{"mappen":{"terminologie":[{"id":"a\\\\b"}]}}', /schuine streep/],
  ['regel-id punt', '{"mappen":{"regels":[{"id":"."}]}}', /(punt|'\.\.')/],
  ['te veel hoofdstukken', JSON.stringify({ templateGuidelines: Array.from({ length: 501 }, (_, i) => ({ id: `h${i + 1}`, titel: 't' })) }), /te veel items \(maximaal 500\)/],
  ['te diep genest', '['.repeat(900000) + ']'.repeat(900000), /te diep genest/],
  ['diep in een hoofdstuk', `{"templateGuidelines":[{"id":"h1","x":${'['.repeat(5000)}${']'.repeat(5000)}}]}`, /te diep genest/],
  ['te lange tekst', JSON.stringify({ templateGuidelines: [{ id: 'h1', titel: 'a'.repeat(50001) }] }), /tekst van meer dan 50000/],
];

/** import validation and the id guard of the save. Bad files give an error toast, add no configuration and
 *  leave the view working; a configuration with a hostile non-object b1Guidelines still renders the B1 tab; an unusable
 *  "Uniek ID" (empty, `notas`, with a slash) stops the save before any request. */
export default {
  id: 'configurator-import-validation', title: 'configurator: import validation, oversize file, id guard of the save', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    await page.locator('.config-item-synced').first().waitFor();
    // only the local copies that an import makes count (ids `conf-<ms>`); the synced configurations come and go with the list load
    const localCount = async () => ((await localGetJson(page, 'gs_nota_db'))?.configurations || []).filter((c) => /^conf-\d{13}$/.test(c.id)).length;
    const before = await localCount();
    const file = (buffer) => page.locator('input[type="file"]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(buffer) });
    const clearToasts = () => page.evaluate(() => document.querySelectorAll('[role="alert"]').forEach((e) => e.remove()));

    for (const [what, text, re] of BAD) {
      await clearToasts();
      const t0 = Date.now();
      await file(text);
      const msg = await waitToast(page, /Fout bij het importeren/);
      assert.ok(Date.now() - t0 < 8000, `${what}: refused without a freeze`);
      assert.equal(await page.evaluate(() => 1 + 1), 2, `${what}: the page still answers`);
      assert.match(msg, re, `${what}: ${msg}`);
      assert.equal(await localCount(), before, `${what}: no configuration added`);
      assert.equal(await page.locator('input[class*="title-input"]').count() > 0, true, `${what}: the view still shows the selected configuration`);
      await sleep(150);
    }
    // oversize: more than 10 MB
    await clearToasts();
    await file(Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    await waitToast(page, /te groot \(maximaal 10 MB\)/);
    assert.equal(await localCount(), before, 'oversize: nothing added');
    assert.equal(rec.api('POST', /upload-configuration/).length, 0, 'no request for any of it');

    // a hostile b1Guidelines (not an object) still lets the B1 tab render
    await clearToasts();
    await file(JSON.stringify({ name: 'hostile b1', templateGuidelines: [], b1Guidelines: 'tekst' }));
    await waitToast(page, /^Configuratie succesvol geïmporteerd!$/);
    assert.equal(await localCount(), before + 1);
    const b1 = page.locator('[class*="tab-btn"]').filter({ hasText: /B1-parameters/i }).first();
    if (await b1.count()) { await b1.click(); await sleep(400); }
    assert.equal(await page.locator('input[class*="title-input"]').inputValue(), 'hostile b1 (Import)');

    // id guard: the folder id is checked before anything is sent
    await page.locator('[class*="tab-btn"]').filter({ hasText: /Eigenschappen/i }).first().click();
    const idInput = page.locator('#config-id');
    for (const [bad, re] of [['notas', /gereserveerd/], ['a/b', /schuine streep/], ['..', /'\.\.'/], ['  ', /niet leeg/], ['a?b', /bevat een \?, # of %/], ['a#b', /bevat een \?, # of %/], ['a%2e', /bevat een \?, # of %/], ['NOTAS', /gereserveerd/]]) {
      await idInput.fill(bad);
      await idInput.blur();
      const t = Date.now();
      await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
      const msg = await waitToast(page, /Opslaan mislukt/);
      assert.match(msg, re, `id ${JSON.stringify(bad)}: ${msg}`);
      await sleep(300);
      assert.equal(rec.api('POST', /upload-configuration/, t).length, 0, `id ${JSON.stringify(bad)}: no POST`);
      assert.equal(rec.api('DELETE', /\/configurations\//, t).length, 0, `id ${JSON.stringify(bad)}: no DELETE`);
      await clearToasts();
    }
    assert.deepEqual(pageErrors, [], 'no uncaught exception in any case (no RangeError from the deep file)');
    // a path-like item id inside a configuration that is already open cannot be saved either (the check runs again at the save)
    assert.equal(rec.api('POST', /upload-configuration/).length, 0, 'nothing was ever sent');
    record('checked', { bad_files: BAD.length + 1 });
  },
};
