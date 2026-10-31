import assert from 'node:assert/strict';
import { v5Chapters } from '../lib/api.mjs';
import { localGetJson, waitView } from '../lib/app.mjs';

/** new nota from `GS-nota v5` -> 15 h2.dynamic-chapter headings with data-chapter-id h1..h15 and the instructie paragraphs.
 *  The content assertion reads the created nota from the app's local cache (`gs_nota_db`, per-user key);
 *  the editor-side assertions read the rendered cells. */
export default {
  id: 'new-nota-from-config', title: 'new nota from GS-nota v5',
  async run({ page, adapter, api, env, rec, record, cleanup }) {
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.nota-list-item');
    await page.getByRole('button', { name: 'Nieuwe Nota' }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="modal-title"]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'GS-nota v5' }).first().click();
    await dialog.getByRole('button', { name: 'Selecteer & Start' }).click();
    record('editor_view', await waitView(page, '.editor-cell[data-block-id]'));

    // the nota lives in localStorage until the first sync; find its id there for the cleanup
    const db = await localGetJson(page, 'gs_nota_db');
    const notaId = db?.notas?.[0]?.id;
    assert.match(String(notaId), /^n\d{13}$/, "id is 'n' + Date.now()");
    cleanup(() => api.deleteNota(notaId));

    const chapters = v5Chapters();
    const cells = await page.locator('.editor-cell[data-block-id]').evaluateAll((els) => els.map((el) => ({
      block: el.getAttribute('data-block-id'),
      h2: el.querySelector('h2.dynamic-chapter')?.getAttribute('data-chapter-id'),
      title: el.querySelector('h2.dynamic-chapter')?.textContent.trim(),
      body: el.querySelector('.cell-content')?.innerHTML,
    })));
    record('cells', cells.map((c) => `${c.h2}:${c.title}`));
    assert.equal(cells.length, 15);
    cells.forEach((c, i) => {
      const g = chapters[i];
      assert.equal(c.h2, g.id); assert.equal(c.block, `block-${g.id}`); assert.equal(c.title, g.titel);
      const instr = (g.instructie || '').trim();
      if (instr) assert.equal(c.body.trim(), `<p><i>${instr}</i></p>`, `${g.id} instructie paragraph`);
      else assert.equal(c.body.trim(), '', `${g.id} has no instructie: empty body`);
    });
    const title = (await page.locator('button[title="Klik om de titel te bewerken"]').textContent()).trim();
    assert.match(title, /^Nieuwe Concept Nota/, 'default title');
    const created = db.notas[0];
    assert.equal(created.title, 'Nieuwe Concept Nota', 'default title');
    const sentHtml = created.content;
    const expected = chapters.map((g) => { const i = (g.instructie || '').trim(); return `<h2 class="dynamic-chapter" data-chapter-id="${g.id}">${g.titel}</h2>${i ? `\n<p><i>${i}</i></p>` : ''}\n`; }).join('\n');
    assert.equal(sentHtml, expected, 'initial content exactly as +page.svelte createNewNota builds it');
    const h2Count = (sentHtml.match(/<h2 class="dynamic-chapter" data-chapter-id="h\d+">/g) || []).length;
    record('h2_count', h2Count);
    assert.equal(h2Count, 15, '15 h2.dynamic-chapter headings h1..h15');
  },
};
