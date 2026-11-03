import assert from 'node:assert/strict';
import { openNota, backToDashboard, putCalls, waitFor } from '../lib/app.mjs';

const FIXTURE_IDS = ['n1760000000001', 'n1760000000002', 'n1760000000003'];

/** load each of the three fixture notas, make no edit, trigger a manual save -> PUT body `content` equals the loaded `content`. */
export default {
  id: 'manual-save-unedited-nota', title: 'manual save of an unedited fixture nota is content-identical',
  async run({ page, adapter, api, rec, record }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    const diffs = {};
    for (const id of FIXTURE_IDS) {
      const stored = await api.getNota(id);
      await openNota(page, stored.title);
      const since = Date.now();
      await page.getByRole('button', { name: 'Opslaan' }).click();
      const puts = await waitFor(() => { const p = putCalls(rec, id, since); return p.length && p[0].doneTs ? p : null; }, { what: `PUT ${id}` });
      assert.equal(puts.length, 1, 'exactly one PUT from the manual save');
      assert.equal(puts[0].status, 200);
      const body = JSON.parse(puts[0].postData);
      diffs[id] = body.content === stored.content ? 'identical' : firstDiff(stored.content, body.content);
      assert.equal(body.content, stored.content, `${id}: content unchanged by load + manual save`);
      assert.equal(body.title, stored.title); assert.equal(body.lastModified, stored.lastModified, 'no edit: lastModified untouched');
      assert.deepEqual(body.notes, stored.notes); assert.deepEqual(body.blockWorkflow, stored.blockWorkflow);
      await waitFor(() => page.locator('[role="alert"]', { hasText: 'Nota succesvol opgeslagen' }).count(), { what: 'success toast' });
      // the manual save with an untouched nota does not call generate-nota-title (titleManuallySet in the fixtures)
      assert.equal(rec.api('POST', /generate-nota-title/, since).length, 0);
      await backToDashboard(page);   // the nota is clean after the manual save: the back sends nothing
    }
    record('content_diffs', diffs);
  },
};

export function firstDiff(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { at: i, stored: JSON.stringify(a.slice(Math.max(0, i - 30), i + 40)), sent: JSON.stringify(b.slice(Math.max(0, i - 30), i + 40)), lengths: [a.length, b.length] };
}
