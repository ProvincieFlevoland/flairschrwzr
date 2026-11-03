import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, putCalls, waitFor, localGetJson } from '../lib/app.mjs';

/** edit the nota in a second tab, then switch back to the first tab -> no merge happens (rule the `storage` and
 *  `visibilitychange` listeners are registered after an early `return` in Workspace.onMount, Workspace.svelte:468-488). */
export default {
  id: 'second-tab-edit', title: 'second tab edit is not merged into the first tab',
  async run({ page, adapter, api, rec, record, cleanup, newPage }) {
    const nota = scratchNota('second-tab-edit');
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    const a = page;
    await adapter.enter(a, { name: 'Test Auteur', role: 'auteur' });
    await openNota(a, nota.title);
    const statusA = a.locator('select.role-select');
    assert.equal(await statusA.inputValue(), 'WIP');

    // second tab, same browser profile (shared localStorage `gs_nota_db`; sessionStorage gate token is per tab)
    const b = await newPage();
    await adapter.enter(b, { name: 'Test Auteur', role: 'auteur' });
    await openNota(b, nota.title);
    const tEdit = Date.now();
    await b.locator('select.role-select').selectOption('Final-draft');          // handleStatusChange: saveDB + debounce
    await b.getByRole('button', { name: 'Opslaan' }).click();                     // manual save: the server is newer now
    await waitFor(() => putCalls(rec, nota.id, tEdit).filter((p) => p.doneTs && JSON.parse(p.postData).status === 'Final-draft').length, { what: 'PUT from tab B' });
    assert.equal((await api.getNota(nota.id)).status, 'Final-draft');
    assert.equal(((await localGetJson(a, 'gs_nota_db')).notas.find((n) => n.id === nota.id) || {}).status, 'Final-draft', 'shared localStorage carries the change');   // per-user key

    // switch back to the first tab
    const tBack = Date.now();
    await a.bringToFront();
    await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // what the listener would react to, if it were registered
    await a.waitForTimeout(2500);
    const gets = rec.api('GET', new RegExp(`/storage/notas/${nota.id}`), tBack);
    record('gets_after_switch_back', gets.length);
    assert.equal(gets.length, 0, 'no GET /notas/{id} (mergeRemoteNotaSafeFields never runs)');
    assert.equal(await statusA.inputValue(), 'WIP', 'tab A still shows the old status: no merge');
    assert.equal(await a.locator('.editor-cell[data-block-id]').count(), 15);
    
  },
};
