import assert from 'node:assert/strict';
import { STORAGE, scratchNota } from '../lib/api.mjs';
import { waitFor, sleep } from '../lib/app.mjs';
import { stamp, configBody, uploadConfig, deleteConfig, configItem, waitToast, listConfigs } from '../lib/configs.mjs';

/** delete confirmation by typing the name: an active configuration and one in use by a nota are refused with no DELETE; the
 *  modal keeps its button disabled for a wrong or partial name, Annuleren / Sluiten / the backdrop send nothing, the exact name
 *  sends DELETE and removes the blobs. */
export default {
  id: 'configurator-delete-confirmation', title: 'configurator: delete needs the typed name, refusals send nothing', timeout: 120000,
  async run({ page, adapter, api, rec, env, record, cleanup }) {
    const s = stamp();
    const act = `test-del-active-${s}`, use = `test-del-use-${s}`, del = `test-del-${s}`;
    const nota = scratchNota('configurator-delete-confirmation', { configId: use, configName: use });
    cleanup(() => api.deleteNota(nota.id));
    for (const id of [act, use, del]) cleanup(() => deleteConfig(api, id));
    await uploadConfig(api, configBody(act, { isActive: true }));
    await uploadConfig(api, configBody(use, { isActive: false }));
    await uploadConfig(api, configBody(del, { isActive: false }));
    await api.putNota(nota);

    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    await configItem(page, del).waitFor();
    const trash = (name) => configItem(page, name).locator('button[aria-label="Configuratie verwijderen"]');
    const t0 = Date.now();

    // active: refused (wait until the metadata of the list has arrived, or the item still reads as inactive)
    // The refusal reads the isActive flag of the store; right after a list load or a poll it can be unset for a moment (
    // once: the modal opened). Try again until the refusal shows, at most five times.
    await configItem(page, act).locator('button[aria-label="Markeer als inactief"]').waitFor();
    let refused = null;
    for (let i = 0; i < 5 && !refused; i++) {
      await trash(act).click();
      refused = await waitToast(page, /kan niet verwijderd worden: deze is nog actief/, { timeout: 2500 }).catch(() => null);
      if (!refused) {
        record('active_refusal_retry', i + 1);
        const open = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
        if (await open.count()) await open.getByRole('button', { name: 'Annuleren' }).click();
        await sleep(1000);
      }
    }
    assert.ok(refused, 'an active configuration is refused');
    assert.equal(await page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]').count(), 0, 'no modal for an active configuration');

    const dlg = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
    const confirm = dlg.getByRole('button', { name: /Verwijderen$/ });
    const input = dlg.locator('input[type="text"]');
    // the in-use check reads the notas from storage on the delete click itself (no need to have opened them first) and
    // fails closed: a failed read refuses the delete.
    await configItem(page, use).locator('button[aria-label="Markeer als inactief"], button[aria-label="Markeer als actief"]').first().waitFor();
    await trash(use).click();
    const usedMsg = await waitToast(page, /wordt nog gebruikt door 1 nota/);
    record('in_use_refusal', usedMsg);
    assert.equal(await dlg.count(), 0, 'no modal for a configuration in use');
    const NOTAS = /\/api\/v1\/storage\/notas(\?|$)/;
    await page.route(NOTAS, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"stuk"}' }) : route.continue()));
    await page.evaluate(() => document.querySelectorAll('[role="alert"]').forEach((e) => e.remove()));
    await trash(del).click();
    const failMsg = await waitToast(page, /er kon niet worden gecontroleerd of nota's deze configuratie nog gebruiken/);
    record('in_use_check_failed_refusal', failMsg);
    await sleep(300);
    assert.equal(await dlg.count(), 0, 'a failed in-use check opens no modal (fails closed)');
    await page.unroute(NOTAS);
    await page.route(NOTAS, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"notas":"geen lijst"}' }) : route.continue()));
    await page.evaluate(() => document.querySelectorAll('[role="alert"]').forEach((e) => e.remove()));
    await trash(del).click();
    await waitToast(page, /er kon niet worden gecontroleerd/);
    assert.equal(await dlg.count(), 0, 'an unreadable answer opens no modal either');
    await page.unroute(NOTAS);
    assert.equal(rec.api('DELETE', /\/configurations\//, t0).length, 0, 'refusals send no DELETE');

    // the modal: wrong, partial, then cancel in three ways
    // the modal: wrong, partial, then cancel in three ways
    await trash(del).click();
    await dlg.waitFor();
    assert.equal((await dlg.locator('code').textContent()).trim(), del, 'the modal asks for the configuration name');
    assert.equal(await confirm.isDisabled(), true);
    await input.fill('verkeerd');
    assert.equal(await confirm.isDisabled(), true, 'a wrong name keeps the button disabled');
    await input.fill(del.slice(0, -1));
    assert.equal(await confirm.isDisabled(), true, 'a partial name keeps the button disabled');
    await input.fill(del.toUpperCase());
    assert.equal(await confirm.isDisabled(), true, 'the match is case sensitive');
    await page.getByRole('button', { name: 'Annuleren' }).click();
    await dlg.waitFor({ state: 'detached' });
    await trash(del).click(); await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Sluiten' }).click();
    await dlg.waitFor({ state: 'detached' });
    await trash(del).click(); await dlg.waitFor();
    await page.mouse.click(5, 5);   // the backdrop
    await dlg.waitFor({ state: 'detached' });
    await sleep(200);
    assert.equal(rec.api('DELETE', /\/configurations\//, t0).length, 0, 'cancelling sends no DELETE');
    assert.ok((await api.get(`${STORAGE}/configurations/${del}/metadata`)).ok, 'the configuration is still stored');

    // a refused DELETE (here: 500) is reported and the row stays
    const DEL = new RegExp(`/api/v1/storage/configurations/${del}$`);
    await page.route(DEL, (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"stuk"}' }) : route.continue()));
    await page.evaluate(() => document.querySelectorAll('[role="alert"]').forEach((e) => e.remove()));
    await trash(del).click(); await dlg.waitFor();
    await input.fill(del);
    await confirm.click();
    const failed = await waitToast(page, /Verwijderen mislukt: de configuratie .* staat nog in storage/);
    record('failed_delete_toast', failed);
    await sleep(300);
    assert.equal(await configItem(page, del).count(), 1, 'a refused DELETE keeps the row');
    assert.ok((await api.get(`${STORAGE}/configurations/${del}/metadata`)).ok, 'and the blobs');
    await page.unroute(DEL);
    await page.evaluate(() => document.querySelectorAll('[role="alert"]').forEach((e) => e.remove()));
    
    // the exact name, confirmed with the Enter key on the second try: the button path is covered by the v5 round trip
    const t1 = Date.now();
    await trash(del).click(); await dlg.waitFor();
    await input.fill(del);
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await waitFor(() => rec.api('DELETE', new RegExp(`/configurations/${del}`), t1).filter((p) => p.doneTs).length === 1, { what: 'DELETE' });
    assert.equal(rec.api('DELETE', /\/configurations\//, t1).length, 1, 'exactly one DELETE');
    assert.equal(new URL(rec.api('DELETE', /\/configurations\//, t1)[0].url).pathname.split('/').pop(), del, 'the DELETE names exactly the confirmed configuration');
    await waitToast(page, /succesvol verwijderd/);
    await configItem(page, del).waitFor({ state: 'detached' });
    assert.equal((await api.get(`${STORAGE}/configurations/${del}/metadata`)).status, 404, 'the blobs are gone');
    const left = (await listConfigs(api)).map((c) => c.id ?? c);
    assert.ok(left.includes(act) && left.includes(use) && !left.includes(del), `only the confirmed one was deleted: ${left}`);
  },
};