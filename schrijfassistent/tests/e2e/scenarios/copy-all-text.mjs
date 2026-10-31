import assert from 'node:assert/strict';
import { v5Chapters } from '../lib/api.mjs';
import { openNota, copyAllText, waitFor, toasts } from '../lib/app.mjs';

/** Kopieer Alles -> clipboard equals the plain text of all blocks (utils/clipboardText.js, mirrored by lib/app.mjs copyAllText):
 *  `${title}\n${body}` per block, the title alone when the body is empty, blocks joined by a blank line; paragraphs on their own
 *  lines, entities decoded, NBSP a plain space, and the untouched template instruction of Onderwerp left out. */
export default {
  id: 'copy-all-text', title: 'Kopieer Alles clipboard text',
  async run({ page, adapter, api, rec, record, env }) {
    const id = 'n1760000000001';
    const stored = await api.getNota(id);
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, stored.title);
    await page.getByRole('button', { name: 'Kopieer Alles' }).click();
    const MSG = 'Volledige nota gekopieerd naar klembord';
      // the app confirms with a toast; no native dialog opens
      await waitFor(async () => (await toasts(page)).some((t) => t.includes(MSG)), { what: 'toast' });
      assert.equal(rec.dialogs.filter((d) => d.type === 'alert').length, 0, 'no native alert');
    
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const expected = copyAllText(stored.content, v5Chapters().map((g) => g.instructie || ''));
    record('clipboard_head', clip.slice(0, 160));
    assert.equal(clip, expected);
    assert.ok(clip.startsWith('Onderwerp\n\nBeslispunten\nKennis te nemen van het voorstel'), 'the untouched instruction of Onderwerp is left out; title line, body, blank line between blocks');
    assert.ok(!clip.includes('&nbsp;') && !clip.includes(' '), 'entities decoded, NBSP a plain space');
    assert.ok(clip.includes('harde spatie .\nFinanciële dekking'), 'paragraphs on their own lines');
    assert.ok(!/<[a-z]/i.test(clip), 'no tags');
    assert.ok(clip.endsWith('\n\nBijlagen'), 'last block (empty body): the title line only');
  },
};
