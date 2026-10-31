import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modal, modalAccept, cellText, cellSel, sleep, localGetJson } from '../lib/app.mjs';

// a plain double space, a four-space run, a space before a comma, an &nbsp; original with a space before the period
const H2 = '<p>Dit is een  dubbele spatie en een    viervoudige spatie , met komma. Daarna een&nbsp;harde spatie .</p>';
const T0 = 'Dit is een  dubbele spatie en een    viervoudige spatie , met komma. Daarna een harde spatie .';
const T1 = 'Dit is een  dubbele spatie en een viervoudige spatie , met komma. Daarna een harde spatie .';
const T2 = 'Dit is een  dubbele spatie en een viervoudige spatie, met komma. Daarna een harde spatie .';
const T3 = 'Dit is een  dubbele spatie en een viervoudige spatie, met komma. Daarna een harde spatie.';

/** accept a one-space replacement, then a punctuation fix, then an `&nbsp;` row -> cell text changes exactly as
 *  `replaceText(original, suggested)` dictates; no trim (skill suggestion-pipeline rules 1-3).
 *
 *  Two limits of the editor are characterised on the way (pinned):
 *  a plain double-space row ("  ") is searched in the WHOLE cell (BlockEditor.highlightScanRoot = header + body) and the header's
 *        inter-element whitespace already holds two or three spaces, so its span lands in the header and the body text never changes.
 *        A run of four spaces has no header match and works; that is the one-space replacement this scenario accepts.
 *  after an agent run the editor's local rows are recomputed from the live HTML including the painted spans (tags -> spaces),
 *        so they no longer match the sidebar's rows; accepting a sidebar local row then changes nothing (replaceText finds no match)
 *        while the row is marked handled. */
export default {
  id: 'accept-rows-without-trimming', title: 'accept one-space, punctuation and nbsp rows without trimming',
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('accept-rows-without-trimming', { content: notaHtml({ h2: H2 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    assert.equal(await cellText(page, 'h2'), T0);
    await selectTab(page, 'spelling');

    // local typography rows exist without any agent run and are visible as spans (the sidebar lists local rows only once agent
    // feedback exists for the chapter, AuteurPane.svelte:1819): " ," local-0, " ." local-1, "  " local-2, "    " local-3
    const spans0 = await spans(page);
    record('spans_initial', spans0);
    assert.deepEqual(spans0.map((s) => s.id), ['spelling-h2-block-h2-local-3', 'spelling-h2-block-h2-local-2', 'spelling-h2-block-h2-local-0', 'spelling-h2-block-h2-local-1'].sort(), 'four local rows painted (sorted by id)');
    assert.deepEqual((await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-h2-')), [], 'sidebar lists no local rows before an agent run');
    const twoSpace = spans0.find((s) => s.id.endsWith('local-2'));
    assert.equal(twoSpace.text, '  ');
    assert.equal(twoSpace.inBody, false, 'the double-space span is in the cell header, not in the body');
    assert.ok(spans0.filter((s) => s.id.endsWith('local-3') || s.id.endsWith('local-0') || s.id.endsWith('local-1')).every((s) => s.inBody), 'the other rows are in the body');

    // a highlight click in a block that is not yet the active block opens the modal and closes it in the same tick
    // (handleFocus sets activeBlockId, and `$: if (activeBlockId || notaId) activeSuggestionStore.set(null)` runs, Workspace.svelte:543).
    await page.locator(`${cellSel('h2')} .suggestion-highlight[data-id="spelling-h2-block-h2-local-3"]`).first().dispatchEvent('mousedown', { bubbles: true });
    await sleep(400);
    const openedOnInactiveBlock = await modal(page).isVisible();
    record('modal_open_after_first_click_on_inactive_block', openedOnInactiveBlock);
    assert.equal(openedOnInactiveBlock, false, 'first highlight click on an inactive block leaves no modal');
    await page.locator('button[aria-label^="Blok: Beslispunten"]').click();   // make h2 the active block (strip, no editor focus)

    // 1. one-space replacement ("    " -> " "): no trim
    await acceptSpan(page, 'spelling-h2-block-h2-local-3');
    assert.equal(await cellText(page, 'h2'), T1, 'four spaces collapsed to one space, nothing else changed (no trim)');
    // 2. punctuation fix (" ," -> ",")
    await acceptSpan(page, 'spelling-h2-block-h2-local-0');
    assert.equal(await cellText(page, 'h2'), T2, 'space before the comma removed');

    // 3. the agent row with an &nbsp; original ("een&nbsp;harde spatie ." -> "een harde spatie.") through the sidebar
    await runCellAi(page, rec, 'h2');
    await selectTab(page, 'spelling');
    const rows = (await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-h2-'));
    record('sidebar_rows_after_agent', rows);
    assert.deepEqual(rows.filter((r) => !/-local-/.test(r)), ['spelling-h2-block-h2-1'], 'only the agent row whose Origineel occurs in the text (canAccept); "twee  spaties" and "accorderen" are dropped');
    await openRowModal(page, 'spelling-h2-block-h2-1');
    assert.equal(await modalAccept(page).isDisabled(), false);
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(250);
    assert.equal(await cellText(page, 'h2'), T3, 'nbsp row applied through the entity/U+00A0 normalisation');
    const stored = (await localGetJson(page, 'gs_nota_db')).notas.find((n) => n.id === nota.id).content;   // per-user key
    assert.ok(stored.includes('<p>Dit is een  dubbele spatie en een viervoudige spatie, met komma. Daarna een harde spatie.</p>'), stored);

    // 4. characterisation the sidebar's remaining local row ("  ", computed from `content`) vs the editor's rows (computed from
    //    the live HTML with spans): accepting it from the sidebar leaves the text unchanged and marks the row handled.
    const local = (await sidebarRowIds(page)).filter((id) => /spelling-h2-block-h2-local-/.test(id));
    record('sidebar_local_rows_after_agent', local);
    if (local.length) {
      await openRowModal(page, local[0]);
      const before = await cellText(page, 'h2');
      if (!(await modalAccept(page).isDisabled())) {
        await modalAccept(page).click();
        await modal(page).waitFor({ state: 'hidden' });
        await sleep(250);
      } else {
        await modal(page).getByRole('button', { name: 'Sluiten' }).click();
      }
      const after = await cellText(page, 'h2');
      record('f21_sidebar_local_accept', { row: local[0], changed: before !== after });
      assert.equal(after, before, 'accepting a sidebar local row after an agent run changes nothing');
    }
  },
};

async function spans(page) {
  return page.locator(`${cellSel('h2')} .suggestion-highlight`).evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, text: e.textContent, inBody: !!e.closest('.cell-content') })).sort((a, b) => a.id.localeCompare(b.id)));
}

/** Opens the modal from a highlight span (mousedown on the span, BlockEditor cell handler) and accepts. Whitespace spans have no box, so dispatch. */
async function acceptSpan(page, id) {
  const span = page.locator(`${cellSel('h2')} .suggestion-highlight[data-id="${id}"]`).first();
  await span.dispatchEvent('mousedown', { bubbles: true });
  await modal(page).waitFor({ state: 'visible' });
  assert.equal(await modalAccept(page).isDisabled(), false, `${id}: Accepteren enabled`);
  await modalAccept(page).click();
  await modal(page).waitFor({ state: 'hidden' });
  await sleep(250);
}
