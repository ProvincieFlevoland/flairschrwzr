import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, cellContent, cellText, cell, highlights, sleep } from '../lib/app.mjs';

// a four-space run and a space before a comma give two painted local rows without any agent run
const H2 = '<p>Dit is een    viervoudige spatie , met komma.</p>';

/** while the caret is in a cell the editor does NOT repaint the highlights (`applyHighlight` with
 *  `respectFocus`, BlockEditor.svelte:202); typing three characters lands contiguously at the caret, the painted span elements are the
 *  same elements afterwards, and the blur repaints them. A port that repaints during typing resets the caret on every keystroke
 *  (text appears "backwards") and replaces the span elements. */
export default {
  id: 'typing-keeps-caret', title: 'typing in a cell keeps the caret and the painted highlights; blur repaints',
  async run({ page, adapter, api, record, cleanup }) {
    const nota = scratchNota('typing-keeps-caret', { content: notaHtml({ h2: H2 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const before = await highlights(page, 'h2');
    record('spans_before', before.map((s) => s.id));
    assert.ok(before.length >= 2, `local rows are painted: ${JSON.stringify(before)}`);

    // tag the span elements, then put the caret after "Dit" in the body and type
    await cell(page, 'h2').evaluate((root) => root.querySelectorAll('.suggestion-highlight').forEach((el) => { el.__j22b = true; }));
    await cellContent(page, 'h2').evaluate((el) => {
      el.focus();
      const p = el.querySelector('p');
      const t = p.firstChild;
      const r = document.createRange();
      r.setStart(t, 3); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.type('XYZ', { delay: 40 });
    await sleep(400);
    const typed = await cellText(page, 'h2');
    record('text_after_typing', typed);
    assert.ok(typed.startsWith('DitXYZ is een'), `the three characters landed contiguously at the caret: ${typed}`);

    const during = await cell(page, 'h2').evaluate((root) => ({ tagged: [...root.querySelectorAll('.suggestion-highlight')].filter((el) => el.__j22b).length, all: root.querySelectorAll('.suggestion-highlight').length }));
    record('spans_while_focused', during);
    assert.equal(during.tagged, before.length, 'the painted span elements are untouched while the caret is in the cell');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.cell-content')), true, 'the caret is still in the cell');

    // blur: the highlights are rebuilt (new elements)
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(600);
    const after = await cell(page, 'h2').evaluate((root) => ({ tagged: [...root.querySelectorAll('.suggestion-highlight')].filter((el) => el.__j22b).length, all: root.querySelectorAll('.suggestion-highlight').length }));
    record('spans_after_blur', after);
    assert.equal(after.tagged, 0, 'after the blur the highlights are repainted (new elements)');
    assert.ok(after.all >= 1, 'and still there (the rows are recomputed from the typed text)');
    assert.ok((await cellText(page, 'h2')).startsWith('DitXYZ is een'), 'the typed text is intact');
  },
};
