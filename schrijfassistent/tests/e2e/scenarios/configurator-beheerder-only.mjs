import assert from 'node:assert/strict';
import { waitFor, sleep } from '../lib/app.mjs';

const LIST = /\/api\/v1\/storage\/configurations(\?|$)/;

/** the configurator is for the beheerder only and stops when it is left. An auteur has no admin entry and the
 *  configuration list is not polled for them; a beheerder in the admin view polls it; leaving the view (Als auteur werken) and
 *  unmount stop the poll, and an unmount aborts a list request that is in flight. */
export default {
  id: 'configurator-beheerder-only', title: 'configurator: beheerder only; poll and requests stop on leave and unmount', timeout: 150000,
  async run({ page, context, adapter, rec, record, env, skip }) {
    const gets = (since) => rec.api('GET', LIST, since).length;

    // 1. an auteur: no admin entry, no polling of the configuration list
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.nota-list-item');
    assert.equal(await page.locator('[data-action="work-as-author"]').count(), 0);
    assert.equal(await page.getByText(/Beheerdersweergave/).count(), 0, 'no way to the admin view');
    assert.equal(await page.locator('[data-admin-denied]').count(), 0);
    assert.equal(await page.locator('[class*="config-selection-item"], input[class*="title-input"]').count(), 0, 'no configurator content for an auteur (the role gate is also anchored in layer 1: viewForRole and the SSR render of the real component)');
    await sleep(1500);
    const a0 = gets(0);
    await sleep(12500);
    assert.equal(gets(0), a0, 'an auteur causes no repeated GET /configurations');
    record('auteur_list_gets', a0);

    // 2. a beheerder in the admin view polls; "Ga naar nota overzicht" (data-action work-as-author) stops it
    const page2 = await context.newPage();
    await adapter.enter(page2, { name: 'Test Beheer', role: 'beheerder' });
    await page2.locator('.config-item-synced').first().waitFor();
    const t1 = Date.now();
    await waitFor(() => gets(t1) >= 2, { timeout: 35000, what: 'two polls of the configuration list in the admin view' });
    record('admin_polls', gets(t1));
    await page2.locator('[data-action="work-as-author"]').click();
    await page2.waitForSelector('.nota-list-item');
    await sleep(1500);
    const t2 = Date.now();
    await sleep(12500);
    assert.equal(gets(t2), 0, 'the poll stops when the admin view is left');

    // 3. back in the admin view, hold the next list answer, unmount: the request is aborted and nothing polls afterwards
    await page2.getByRole('button', { name: 'Beheerdersweergave' }).click();
    await page2.locator('.config-item-synced').first().waitFor();
    await context.route(LIST, async (route) => { await sleep(7000); try { await route.continue(); } catch { /* aborted */ } });
    const t3 = Date.now();
    await waitFor(() => rec.requests.some((r) => r.method === 'GET' && LIST.test(r.url) && r.ts >= t3 && !r.doneTs), { timeout: 15000, what: 'a held list request' });
    const tU = Date.now();
    await page2.evaluate(async () => { await window.SchrijfassistentApp.unmount(); });
    await sleep(10000);
    const after = rec.requests.filter((r) => r.method === 'GET' && LIST.test(r.url) && r.ts >= tU);
    record('list_requests_after_unmount', after.length);
    assert.equal(after.filter((r) => r.status === 200).length, 0, 'no list answer is delivered after the unmount');
    assert.equal(after.length, 0, 'no new list request after the unmount');
    const held = rec.requests.filter((r) => r.method === 'GET' && LIST.test(r.url) && r.ts >= t3 && r.ts < tU);
    assert.ok(held.every((r) => r.failed || r.status === null || r.ts < tU), 'the held request did not complete');
  },
};
