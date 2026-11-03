import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, cellHtml, cellContent, typeInCell, localGetJson, putCalls, waitFor } from '../lib/app.mjs';

// Every element and attribute of the allow-list once, in one cell body. The two painted classes
// `suggestion-highlight` and `non-b1-word` are on the allow-list too, but BlockEditor.applyHighlight unwraps them from the live cell by design,
// so a browser cannot show them; tests/safety-filter.test.mjs covers them.
const FULL_SET = [
  '<p>Alinea met <strong>sterk</strong>, <em>nadruk</em>, <b>vet</b>, <i>cursief</i> en <u>onderstreept</u>.<br>Nieuwe regel.</p>',
  '<ul><li>punt een</li><li>punt twee</li></ul>',
  '<ol><li>eerste</li><li>tweede</li></ol>',
  '<div>een div, zoals Chrome die bij Enter schrijft</div>',
  '<p><span class="reviewer-highlight" data-note-id="note-j34c" style="background-color: rgba(59, 130, 246, 0.19); border-bottom: 2px solid rgb(59, 130, 246);">notitie</span> ' +
    '<span class="highlight-yellow dynamic-highlight" data-sug-id="r1">oud</span> <span class="highlight-red">rood</span>' +
    '<span class="reviewer-highlight resolved" data-note-id="note-j34c-2">opgelost</span></p>',
  '<p title="titel" lang="nl" dir="ltr" data-x="1">attributen</p>',
].join('');

// A clean nota that the DOM would serialise differently: upper-case tags, single-quoted attributes, a self-closing br, an unclosed p and li,
// a raw `&amp;`, a non-breaking space entity and a double space. The filter removes nothing, so the string must come back byte for byte.
const NON_CANONICAL = "<h2 class='dynamic-chapter' data-chapter-id='h1'>Onderwerp</h2>\n<P>Een <B>vet</B> woord<BR/>en een &amp; teken &nbsp; en  dubbele  spaties.\n<UL><LI>punt een<LI>punt twee</UL>\n<h2 class='dynamic-chapter' data-chapter-id='h2'>Beslispunten</h2>\n<p class='dynamic-highlight' title='titel'>klasse binnen de lijst</p>\n";

/** (1) a nota that carries the whole allow-list (p, i, b, u, strong, em, br, ul, ol, li, div, span with its
 *  classes, data-* and the reviewer style, title, lang, dir) is opened: every element and attribute is still in the cell; (2) the byte-identical
 *  fast path: a clean but non-canonical nota that is never opened sits in the list, and the per-user cache written by a later edit holds exactly the
 *  string the backend stored (the filter returned the original, not a re-serialisation). */
export default {
  id: 'safety-filter-allow-list', title: 'safety filter: the full allow-list survives; a clean non-canonical string is returned byte for byte',
  async run({ page, adapter, api, rec, record, cleanup }) {
    const full = scratchNota('safety-filter-allow-list', { title: 'Test volledig', content: notaHtml({ h1: FULL_SET }) });
    const plain = scratchNota('safety-filter-allow-list', { title: 'Test niet-canoniek', content: NON_CANONICAL });
    await api.putNota(full); await api.putNota(plain);
    cleanup(() => api.deleteNota(full.id)); cleanup(() => api.deleteNota(plain.id));
    assert.equal((await api.getNota(plain.id)).content, NON_CANONICAL, 'the backend stores the string as it was sent');
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, full.title);

    // 1. the whole allow-list is still in the cell
    const html = await cellHtml(page, 'h1');
    record('cell_html_h1', html);
    const must = [
      '<strong>sterk</strong>', '<em>nadruk</em>', '<b>vet</b>', '<i>cursief</i>', '<u>onderstreept</u>', '<br>', '<ul><li>punt een</li><li>punt twee</li></ul>',
      '<ol><li>eerste</li><li>tweede</li></ol>', '<div>een div', 'class="reviewer-highlight"', 'data-note-id="note-j34c"', 'rgba(59, 130, 246, 0.19)', 'border-bottom: 2px solid rgb(59, 130, 246)',
      'class="highlight-yellow dynamic-highlight"', 'data-sug-id="r1"', 'class="highlight-red"', 'class="reviewer-highlight resolved"', 'title="titel"', 'lang="nl"', 'dir="ltr"', 'data-x="1"',
    ];
    for (const m of must) assert.ok(html.includes(m), `${m} survives the filter: ${html}`);
    const headers = await page.locator('.editor-cell[data-block-id] h2.dynamic-chapter').count();
    assert.equal(headers, 15, 'the 15 chapter headings (class dynamic-chapter, data-chapter-id) survive');

    // 2. fast path: type one character in the opened nota (saveDB writes every nota of the list to the per-user cache), then read the cache
    await typeInCell(page, 'h2', 'x');
    await waitFor(async () => { const db = await localGetJson(page, 'gs_nota_db'); return (db?.notas || []).some((n) => n.id === full.id && n.lastModified !== full.lastModified); }, { what: 'cache written after the edit' });
    const db = await localGetJson(page, 'gs_nota_db');
    const cached = (db.notas || []).find((n) => n.id === plain.id);
    assert.ok(cached, 'the never-opened nota is in the list and in the cache');
    record('cached_non_canonical_equal', cached.content === NON_CANONICAL);
    assert.equal(cached.content, NON_CANONICAL, 'a clean but non-canonical string is returned unchanged (fast path), not re-serialised');
    // the rest of the list is not rewritten either
    assert.equal(putCalls(rec, plain.id).length, 0, 'the nota that was never opened is never saved');
  },
};
