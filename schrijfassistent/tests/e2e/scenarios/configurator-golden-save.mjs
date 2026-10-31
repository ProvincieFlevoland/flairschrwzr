import assert from 'node:assert/strict';
import { fixture } from '../lib/api.mjs';
import { waitFor, sleep, waitNotice } from '../lib/app.mjs';
import { stamp, uploadConfig, deleteConfig, configItem, v5Inner } from '../lib/configs.mjs';

/** editing really edits: a configuration seeded from the v5 fixture is
 *  opened, chapter h1 gets a new title, instruction and goal plus one added requirement and one added good example, chapter h2 gets
 *  new agent instructions (structuur, b1), the properties tab gets a new name, version, description and tone and the active box is
 *  cleared (one PATCH), section h4 is deleted (the typed modal asks for `h4`
 *  harness; the rest renumbers to h1..h14), and the save body is compared WHOLE with a golden built from the fixture: nothing else
 *  changed, so a save that drops a field, keeps the old name, forgets the deletion or renumbers wrongly fails here. Both targets. */
export default {
  id: 'configurator-golden-save', title: 'configurator: edits, section delete and the whole save body against a golden', timeout: 150000,
  async run({ page, adapter, api, rec, env, record, cleanup }) {
    const s = stamp();
    const id = `test-edit-${s}`;
    cleanup(() => deleteConfig(api, id));
    const inner = structuredClone(v5Inner());
    assert.equal(inner.mappen.hoofdstukken.length, 15);
    await uploadConfig(api, { [id]: { ...inner, name: `Test Edit ${s}` } });

    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    const item = configItem(page, `Test Edit ${s}`);
    await item.waitFor();
    await waitFor(() => rec.api('GET', new RegExp(`/configurations/${id}/hoofdstukken/data`)).some((r) => r.doneTs), { timeout: 20000, what: 'configuration loaded' });
    await sleep(300);
    await item.click();
    await page.locator('input[class*="title-input"]').waitFor();
    const cards = page.locator('[class*="admin-template-card"]');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 15, 'fifteen sections');
    const card = (n) => cards.filter({ has: page.locator('[class*="idx"]', { hasText: new RegExp(`^h${n}$`) }) }).first();
    const open = async (n) => { await card(n).locator('[class*="card-bar"]').click({ position: { x: 8, y: 8 } }); };
    // icon-only buttons may have no size under the test server, so they are clicked through a dispatched event
    const press = (loc) => (loc.click());
    const fillBlur = async (loc, v) => { await loc.fill(v); await loc.blur(); await sleep(60); };

    // chapter h1
    await open(1);
    await fillBlur(card(1).locator('[class*="card-bar"] input'), 'Nieuwe titel h1');
    // "Vereiste toevoegen" / "Voorbeeld toevoegen" append an empty value to the data, but the row shows only after the next field blur
    // (the rows are part of the save body either way). Click both, blur a field, then fill the rows.
    const reqInputs = card(1).locator('input[placeholder="Voeg vereiste toe..."]');
    const exInputs = card(1).locator('input[placeholder^="Bv: Aanbesteding"]');
    const reqBefore = await reqInputs.count(), exBefore = await exInputs.count();
    await card(1).getByRole('button', { name: /Vereiste toevoegen/ }).click();
    await card(1).getByRole('button', { name: /Voorbeeld toevoegen/ }).first().click();
    await fillBlur(page.locator('#inst-h1'), 'Nieuwe instructie h1');
    await fillBlur(page.locator('#doel-h1'), 'Nieuw doel h1');
    await waitFor(async () => (await reqInputs.count()) === reqBefore + 1 && (await exInputs.count()) === exBefore + 1, { what: 'the two new rows' });
    await fillBlur(reqInputs.last(), 'Nieuwe vereiste h1');
    await fillBlur(exInputs.last(), 'Nieuw voorbeeld h1');
    // chapter h2
    await open(2);
    await fillBlur(page.locator('#struct-h2'), 'Nieuwe structuur h2');
    await fillBlur(page.locator('#b1-h2'), 'Nieuwe b1 h2');

    // delete section h4
    const t0 = Date.now();
    await press(card(4).locator('button[aria-label="Sectie verwijderen"]'));
      const dlg = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
      await dlg.waitFor();
      assert.equal((await dlg.locator('code').textContent()).trim(), 'h4', 'the modal asks for the section id');
      const confirm = dlg.getByRole('button', { name: /Verwijderen$/ });
      assert.equal(await confirm.isDisabled(), true);
      await dlg.locator('input[type="text"]').fill('h5');
      assert.equal(await confirm.isDisabled(), true, 'a wrong id keeps the button disabled');
      await dlg.getByRole('button', { name: 'Annuleren' }).click();
      await dlg.waitFor({ state: 'detached' });
      assert.equal(await cards.count(), 15, 'cancel keeps every section');
      await press(card(4).locator('button[aria-label="Sectie verwijderen"]'));
      await dlg.waitFor();
      await dlg.locator('input[type="text"]').fill('h4');
      await confirm.click();
      await dlg.waitFor({ state: 'detached' });
    
    await waitFor(async () => (await cards.count()) === 14, { what: '14 sections after the delete' });

    // properties
    await page.locator('[class*="tab-btn"]').filter({ hasText: /Eigenschappen/i }).first().click();
    await fillBlur(page.locator('#config-name'), `Test Edit ${s} gewijzigd`);
    await fillBlur(page.locator('#config-version'), 'v9.9');
    await fillBlur(page.locator('#config-description'), 'Een nieuwe beschrijving.');
    await page.locator('#config-tone').selectOption('Formeel');
    const t1 = Date.now();
    await page.locator('input[type="checkbox"]').first().uncheck();
    const patches = await waitFor(() => { const p = rec.api('PATCH', new RegExp(`/configurations/${id}/metadata`), t1); return p.length && p[0].doneTs ? p : null; }, { what: 'PATCH isActive' });
    assert.equal(JSON.parse(patches[0].postData).isActive, false, 'the active box sends isActive false');

    // save, compare the whole body
    const t2 = Date.now();
    await page.getByRole('button', { name: 'Opslaan naar Storage' }).click();
    const posts = await waitFor(() => { const p = rec.api('POST', /upload-configuration/, t2); return p.length && p[0].doneTs ? p : null; }, { what: 'POST' });
    await waitNotice(page, rec, env, /succesvol opgeslagen/, { since: t2 });
    const body = JSON.parse(posts[0].postData);
    assert.deepEqual(Object.keys(body), [id]);

    const h = structuredClone(inner.mappen.hoofdstukken);
    h[0] = { ...h[0], titel: 'Nieuwe titel h1', instructie: 'Nieuwe instructie h1', doel: 'Nieuw doel h1', vereisten: [...(h[0].vereisten || []), 'Nieuwe vereiste h1'], voorbeelden: [...(h[0].voorbeelden || []), 'Nieuw voorbeeld h1'] };
    h[1] = { ...h[1], agent_structuur: 'Nieuwe structuur h2', agent_b1: 'Nieuwe b1 h2' };
    const golden = {
      name: `Test Edit ${s} gewijzigd`, templateVersion: 'v9.9', description: 'Een nieuwe beschrijving.', toneOfVoice: 'Formeel', isActive: false,
      mappen: {
        hoofdstukken: [...h.slice(0, 3), ...h.slice(4)].map((g, i) => ({ ...g, id: `h${i + 1}` })),
        terminologie: inner.mappen.terminologie, regels: inner.mappen.regels,
        woordenlijst: inner.mappen.woordenlijst, // the stored woordenlijst travels
      },
      b1Guidelines: inner.b1Guidelines,
    };
    const sent = body[id];
    const norm = (o) => JSON.parse(JSON.stringify(o));
    for (const k of Object.keys(golden)) if (k !== 'mappen') assert.deepEqual(norm(sent[k]), norm(golden[k]), `body.${k}`);
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(golden).sort(), 'the body carries exactly these top-level fields');
    assert.equal(sent.mappen.hoofdstukken.length, 14);
    assert.deepEqual(sent.mappen.hoofdstukken.map((g) => g.id), Array.from({ length: 14 }, (_, i) => `h${i + 1}`), 'ids renumbered');
    sent.mappen.hoofdstukken.forEach((g, i) => assert.deepEqual(norm(g), norm(golden.mappen.hoofdstukken[i]), `chapter h${i + 1}`));
    assert.deepEqual(norm(sent.mappen.terminologie), norm(golden.mappen.terminologie));
    assert.deepEqual(norm(sent.mappen.regels), norm(golden.mappen.regels));
    assert.deepEqual(sent.mappen.woordenlijst, golden.mappen.woordenlijst, 'the woordenlijst is saved unchanged');
    record('body_keys', Object.keys(sent));
  },
};
