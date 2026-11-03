import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v5Chapters } from '../lib/api.mjs';
import { waitFor, sleep, localGetJson, buttonByText } from '../lib/app.mjs';
import { stamp, PAYLOADS, configBody, uploadConfig, deleteConfig, configItem } from '../lib/configs.mjs';

/** hostile configuration content. A configuration whose name, chapter title, chapter instruction and rule words
 *  carry markup is shown as text everywhere in the configurator (list, editor, delete modal, export), nothing runs and nothing is
 *  fetched, and a nota that starts from it holds the filtered chapter markup (the content is built from the configuration). */
export default {
  id: 'configurator-hostile-content', title: 'hostile configuration content stays text, never runs, never reaches a nota as markup', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const s = stamp();
    const hid = `test-host-${s}`;
    const name = `JH${s} ${PAYLOADS.img} ${PAYLOADS.svg}`;
    const chapters = v5Chapters().slice(0, 3).map((c) => ({ ...c }));
    chapters[0].titel = `Titel ${PAYLOADS.img}`;
    chapters[0].instructie = `Let op ${PAYLOADS.script}${PAYLOADS.beacon}${PAYLOADS.anchor}${PAYLOADS.iframe}`;
    chapters[1].titel = `Twee ${PAYLOADS.svg}`;
    chapters[1].instructie = PAYLOADS.style;
    const rules = [{ id: 'rh1', category: 'Regels', severity: 'medium', triggerWords: [PAYLOADS.img, PAYLOADS.script], alternatives: [PAYLOADS.anchor], explanation: PAYLOADS.iframe }];
    cleanup(() => deleteConfig(api, hid));
    cleanup(async () => { for (const n of await api.listNotas().catch(() => [])) if (n.configId === hid) await api.deleteNota(n.id); });
    await uploadConfig(api, configBody(hid, { name, isActive: true, mappen: { hoofdstukken: chapters, regels: rules, terminologie: [], woordenlijst: [] } }));

    await adapter.enter(page, { name: 'Test Beheer', role: 'beheerder' });
    const item = configItem(page, `JH${s}`);
    await item.waitFor();
    const clean = () => page.evaluate(() => ({
      pwned: window.__pwned,
      bad: document.querySelectorAll('#sa-container img[onerror], #sa-container svg[onload], #sa-container iframe, #sa-container script, #sa-container a[href^="javascript:"], #sa-container img[src*="test-canary"]').length,
    }));
    const shouldBeClean = async (where) => {
      const c = await clean();
      assert.equal(c.pwned, undefined, `${where}: nothing ran`);
      assert.equal(c.bad, 0, `${where}: no injected element`);
    };

    // the list shows the name as text
    assert.equal(await item.locator('img, svg[onload]').count(), 0);
    assert.ok((await item.textContent()).includes('<img src=x onerror='), 'the markup is visible as text in the list');
    await item.click();
    await page.locator('input[class*="title-input"]').waitFor();
    assert.equal(await page.locator('input[class*="title-input"]').inputValue(), name, 'the name is the input value, unchanged');
    await shouldBeClean('editor');

    // every tab
    for (const label of [/Hoofdstukken/i, /Regels/i, /Terminologie/i, /B1-parameters/i, /Eigenschappen/i, /Woordenlijst/i]) {
      const tab = page.locator('[class*="tab-btn"]').filter({ hasText: label }).first();
      if (await tab.count()) { await tab.click(); await sleep(250); await shouldBeClean(String(label)); }
    }
    await page.locator('[class*="tab-btn"]').filter({ hasText: /Hoofdstukken/i }).first().click();
    const titles = await page.locator('input[placeholder="Hoofdstuktitel..."]').evaluateAll((els) => els.map((e) => e.value));
    assert.ok(titles.some((t) => t.includes(PAYLOADS.img)), 'a chapter title is an input value with its markup as text');

    // the delete modal prints the name as text
    await item.locator('button[aria-label="Markeer als inactief"]').click();
    await item.locator('button[aria-label="Markeer als actief"]').waitFor();
    await item.locator('button[aria-label="Configuratie verwijderen"]').click();
    const dlg = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
    await dlg.waitFor();
    assert.equal(await dlg.locator('img, svg, iframe').count(), 0, 'no element made from the name in the modal');
    assert.ok((await dlg.locator('code').textContent()).includes('<img src=x onerror='), 'the code element shows the name as text');
    await shouldBeClean('delete modal');
    await dlg.getByRole('button', { name: 'Annuleren' }).click();
    await item.locator('button[aria-label="Markeer als actief"]').click();   // back to active for the nota flow
    await item.locator('button[aria-label="Markeer als inactief"]').waitFor();

    // export keeps the strings intact
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exporteer' }).click()]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.name, name);
    assert.equal(exported.templateGuidelines.find((g) => g.id === chapters[0].id).instructie, chapters[0].instructie, 'the instruction is exported byte for byte');

    // a nota from this configuration
    await page.locator('[data-action="work-as-author"]').click();
    await page.waitForSelector('.nota-list-item, [class*="nota-list"]');
    await page.getByRole('button', { name: 'Nieuwe Nota' }).click();
    const modal = page.locator('[role="dialog"][aria-labelledby="modal-title"]');
    await modal.waitFor();
    const card = modal.locator('button', { hasText: `JH${s}` }).first();
    await card.waitFor();
    assert.equal(await card.locator('img, svg').count(), 0, 'the new-nota card shows the name as text');
    await card.click();
    await modal.getByRole('button', { name: 'Selecteer & Start' }).click();
    await page.waitForSelector('.editor-cell[data-block-id]');
    await sleep(600);
    await shouldBeClean('editor of the new nota');
    const db = await localGetJson(page, 'gs_nota_db');
    const created = db.notas.find((n) => n.configId === hid);
    assert.ok(created, 'the nota exists');
    record('nota_content', created.content);
    for (const bad of ['onerror', '<script', '<iframe', 'javascript:', 'onload', '<svg', '<style', 'test-canary']) {
      assert.ok(!created.content.includes(bad), `${bad} is not in the nota content: ${created.content}`);
    }
    assert.ok(created.content.includes('data-chapter-id'), 'the chapter headings are still there');
    const t = Date.now();
    await buttonByText(page, 'Opslaan').first().click();
    const put = await waitFor(() => { const p = rec.api('PUT', new RegExp(`/storage/notas/${created.id}`), t); return p.length && p[0].doneTs ? p : null; }, { what: 'PUT nota' });
    const sent = JSON.parse(put[0].postData).content;
    assert.ok(!/onerror|<script|<iframe|javascript:|onload|<svg|<style/.test(sent), `the PUT body holds filtered content: ${sent}`);
    await sleep(800);
    await shouldBeClean('after save');
    assert.deepEqual(rec.external.filter((u) => /test-canary/.test(u)), [], 'nothing was requested from the canary host');
  },
};
