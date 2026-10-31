import assert from 'node:assert/strict';
import { fixtureNotaCopy } from '../lib/api.mjs';
import { openNota, backToDashboard, putCalls, waitFor, typeInCell, cellContent, sleep } from '../lib/app.mjs';
import { firstDiff } from './manual-save-unedited-nota.mjs';

/** every nota JSON in the dev Blob container loaded through the UI, left unedited, and saved -> `content` after load and
 *  serialise equals the stored `content`, allowing only the normalisation Workspace performs today. The safety filter of
 *  must remove nothing from any existing nota.
 *  The normalisation is characterised on a scratch copy with a no-op edit (type a character, delete it): the edited block is
 *  re-serialised as `${headerHtml}\n${bodyInnerHTML}` and the blocks joined by "\n" (Workspace.updateBlockContent). */
export default {
  id: 'stored-notas-round-trip', title: 'every stored nota: load, save unedited, content identical; normalisation recorded', timeout: 180000,
  async run({ page, adapter, api, env, rec, record, cleanup }) {
    const all = await api.listNotas();
    assert.ok(all.length >= 3, 'the three fixture notas are present');
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    const results = {};
    const skipped = all.filter((n) => !/h2 class="dynamic-chapter"/.test(n.content || ''));
    record('skipped_no_chapters', skipped.map((n) => n.id));   // a nota without chapter headings renders no cell (B1: empty editorBlocks)
    for (const stored of all.filter((n) => !skipped.includes(n))) {
      await openNota(page, stored.title);
      const since = Date.now();
      await page.getByRole('button', { name: 'Opslaan' }).click();
      const puts = await waitFor(() => { const p = putCalls(rec, stored.id, since); return p.length && p[0].doneTs ? p : null; }, { what: `PUT ${stored.id}` });
      const body = JSON.parse(puts[0].postData);
      results[stored.id] = body.content === stored.content ? 'identical' : firstDiff(stored.content, body.content);
      assert.equal(body.content, stored.content, `${stored.id} (${stored.title}): content unchanged by load + save`);
      await waitFor(() => page.locator('[role="alert"]', { hasText: 'Nota succesvol opgeslagen' }).count(), { what: 'success toast' });
      await backToDashboard(page);
      // the nota is clean after the manual save: leaving the editor sends nothing
    }
    record('unedited_save', results);
      // safety filter: the filter removed nothing from any stored nota. The save above PUT the loaded-and-filtered
      // content; a GET afterwards must equal the stored content byte for byte (the contract tests compare the raw blob bytes).
      const after = {};
      for (const stored of all.filter((n) => !skipped.includes(n))) {
    const now = await api.getNota(stored.id);
    after[stored.id] = now.content === stored.content ? 'identical' : firstDiff(stored.content, now.content);
    assert.equal(now.content, stored.content, `${stored.id}: GET after load + save equals the stored content (the safety filter is a no-op)`);
      }
      record('safety_filter_noop_after_save', after);
    

    // characterisation of the parser's own normalisation on a scratch copy of the WIP fixture: no-op edit in block h3
    const copy = fixtureNotaCopy('nota-wip.json', 'stored-notas-round-trip', { blockWorkflow: {} });
    await api.putNota(copy);
    cleanup(() => api.deleteNota(copy.id));
    await page.reload({ waitUntil: 'domcontentloaded' });        // the dashboard list is fetched on mount only
    await adapter.login(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, copy.title);
    await cellContent(page, 'h3').click();
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    await sleep(200);
    const since = Date.now();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    const puts = await waitFor(() => { const p = putCalls(rec, copy.id, since); return p.length && p[0].doneTs ? p : null; }, { what: 'PUT after no-op edit' });
    const sent = JSON.parse(puts[0].postData).content;
    const diff = sent === copy.content ? 'identical' : firstDiff(copy.content, sent);
    record('noop_edit_normalisation', { diff, stored_length: copy.content.length, sent_length: sent.length, stored_tail: JSON.stringify(copy.content.slice(-80)), sent_tail: JSON.stringify(sent.slice(-80)) });
    // What the normalisation changes: the "\n" text nodes kept inside each block by parseContentToBlocks are re-joined with
    // "\n" after the header and "\n" between blocks, so every edit ADDS newlines between blocks (1665 -> 1723 chars here);
    // the edited empty block keeps the <br> Chrome leaves behind after type + Backspace. Text and tags never change.
    const collapse = (t) => t.replace(/<br>/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    assert.equal(collapse(sent), collapse(copy.content), 'a no-op edit changes at most inter-element whitespace (B1 split + join) and a browser <br>');
    assert.ok(sent.length > copy.content.length, 'newlines accumulate on every edit');
    // shape: every chapter header is followed by exactly "\n" + body, blocks joined by "\n"
    const headers = sent.match(/<h2 class="dynamic-chapter" data-chapter-id="h\d+">[^<]*<\/h2>/g);
    assert.equal(headers.length, 15);
    assert.ok(sent.split('<h2 class="dynamic-chapter"').slice(1).every((part) => /<\/h2>\n/.test(part)), 'headerHtml + "\\n" + content per block');
  },
};
