import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { notaItem, waitFor } from '../lib/app.mjs';

/** delete a nota: type a wrong title, then the right title -> delete button disabled, then DELETE observed. */
export default {
  id: 'delete-nota', title: 'delete nota with typed confirmation',
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('delete-nota', { title: 'Test verwijderen' });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await notaItem(page, nota.title).click();
    await page.getByRole('button', { name: 'Verwijder Nota' }).click();
    const dlg = page.locator('[role="dialog"][aria-labelledby="delete-modal-title"]');
    await dlg.waitFor();
    const confirm = dlg.getByRole('button', { name: 'Verwijderen' });
    const input = dlg.locator('input[type="text"]');
    assert.equal(await confirm.isDisabled(), true, 'disabled before typing');
    await input.fill('Test verwijder');                     // wrong title
    assert.equal(await confirm.isDisabled(), true, 'disabled on a wrong title');
    assert.equal(rec.api('DELETE', /\/storage\/notas\//).length, 0);
    await input.fill(nota.title);
    assert.equal(await confirm.isDisabled(), false, 'enabled on the exact title');
    await confirm.click();
    const del = await waitFor(() => { const d = rec.api('DELETE', /\/storage\/notas\//); return d.length && d[0].doneTs ? d : null; }, { what: 'DELETE request' });
    assert.equal(decodeURIComponent(new URL(del[0].url).pathname.split('/').pop()), nota.id);
    assert.equal(del[0].status, 200);
    record('delete_status', del[0].status);
    await waitFor(async () => (await notaItem(page, nota.title).count()) === 0, { what: 'nota gone from the list' });
    assert.equal((await api.get(`/api/v1/storage/notas/${nota.id}`)).status, 404, 'blob gone');
  },
};
