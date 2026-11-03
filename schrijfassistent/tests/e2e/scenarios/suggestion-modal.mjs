import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modal, modalAccept, cellText, activeHighlightId, waitFor, sleep, localGet } from '../lib/app.mjs';

const H2 = '<p>Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis. Wij verzoeken u dit te accorderen. Daarna volgt de rest.</p>';
const T0 = 'Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis. Wij verzoeken u dit te accorderen. Daarna volgt de rest.';

/** accept then undo; press `[` and `]`; press `Y` with auto-advance on -> original text restored; modal moves to the previous and
 *  next row; next row opens after accept. Multi-alternative rows start with no selection. */
export default {
  id: 'suggestion-modal', title: 'modal: accept/undo, [ ] navigation, Y with auto-advance, B1 alternatives',
  async run({ page, adapter, api, rec, record, cleanup, env }) {
    const nota = scratchNota('suggestion-modal', { content: notaHtml({ h2: H2 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    assert.equal(await cellText(page, 'h2'), T0);
    await runCellAi(page, rec, 'h2');

    // queue on the Instructies tab (filter all): structuur, b1 x2, spelling (lastSuggestions order)
    await selectTab(page, 'structuur');
    const ids = (await sidebarRowIds(page)).filter((id) => /-h2-block-h2-/.test(id));
    record('rows', ids);
    await selectTab(page, 'spelling');
    assert.deepEqual((await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-')), ['spelling-h2-block-h2-2'], 'spelling: "accorderen"');

    // 1. accept then undo (a Direct Duidelijk row: its handled entry stays listed below for spelling rows)
    await selectTab(page, 'b1');
    const b1 = (await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-'));
    assert.deepEqual(b1, ['agent_b1-h2-block-h2-0', 'agent_b1-h2-block-h2-1']);
    await openRowModal(page, b1[0]);
    await page.keyboard.press('1');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(250);
    const accepted = T0.replace('Kennis te nemen van het voorstel om een parkeergarage te bouwen onder het provinciehuis.', 'Een parkeergarage te bouwen onder het provinciehuis.');
    assert.equal(await cellText(page, 'h2'), accepted, 'accepted: Herschrijvingen[0].Tekst applied');
    const handled = page.locator(`[data-sidebar-suggestion-id="${b1[0]}"]`).first();
    assert.ok((await handled.textContent()).includes('Geaccepteerd'), 'handled row listed');
    await handled.locator('button').first().click();
    await page.getByRole('button', { name: 'Ongedaan maken' }).click();
    await sleep(250);
    assert.equal(await cellText(page, 'h2'), T0, 'undo: original text restored (replaceText(appliedText, originalText))');
    assert.ok(!(await page.locator(`[data-sidebar-suggestion-id="${b1[0]}"]`).first().textContent()).includes('Geaccepteerd'), 'row is pending again');

    // 2. [ and ] move between rows of the filtered queue without dismissing anything
    await openRowModal(page, b1[0]);
    assert.equal(await activeHighlightId(page), b1[0]);
    // two alternatives -> no selection, accept disabled until 1/2 is pressed
    assert.equal(await modal(page).locator('input[type="radio"]').count(), 2);
    assert.equal(await modal(page).locator('input[type="radio"]:checked').count(), 0, 'multi-alternative row starts with no selection');
    assert.equal(await modalAccept(page).isDisabled(), true);
    await page.keyboard.press('y');
    assert.ok(await modal(page).isVisible(), 'Y without a chosen alternative does nothing');
    await page.keyboard.press(']');
    await waitFor(async () => (await activeHighlightId(page)) === b1[1], { what: 'next row after ]' });
    assert.ok(await modal(page).isVisible());
    await page.keyboard.press('[');
    await waitFor(async () => (await activeHighlightId(page)) === b1[0], { what: 'previous row after [' });
    await page.keyboard.press('[');
    await sleep(300);
    // the queue has ends: `[` on the first row (and `]` on the last) keeps the modal where it is instead of closing it
    // (goToAdjacentInQueue asks the workspace first and closes only when a neighbour opens); nothing is dismissed
    assert.equal(await modal(page).isVisible(), true, '[ on the first row keeps the modal open');
    assert.equal(await activeHighlightId(page), b1[0], 'still on the first row');
    assert.deepEqual((await sidebarRowIds(page)).filter((id) => id.startsWith('agent_b1-')), b1, 'navigation dismissed nothing');
    await page.keyboard.press('Escape');
    await modal(page).waitFor({ state: 'hidden' });
    await openRowModal(page, b1[0]);

    // 3. Y with auto-advance on: choose alternative 1, accept, the next row opens
    const auto = modal(page).locator('input[type="checkbox"]');
    if (!(await auto.isChecked())) await auto.check();
    await modal(page).focus();      // shortcuts are ignored while an input (the checkbox just clicked) has focus (isTypingTarget)
    await page.keyboard.press('1');
    assert.equal(await modal(page).locator('input[type="radio"]:checked').count(), 1);
    assert.equal(await modalAccept(page).isDisabled(), false);
    await page.keyboard.press('y');
    await waitFor(async () => (await activeHighlightId(page)) === b1[1], { what: 'auto-advance to the next row' });
    assert.ok(await modal(page).isVisible(), 'next row opened after accept');
    const text = await cellText(page, 'h2');
    record('text_after_b1_accept', text);
    assert.ok(text.startsWith('Een parkeergarage te bouwen onder het provinciehuis.'), 'first alternative applied (Herschrijvingen[0].Tekst)');
    assert.equal(await localGet(page, 'govchat-suggestion-auto-advance'), '1', 'auto-advance persisted');
    // the exact key is user-suffixed
    assert.equal(await page.evaluate(() => localStorage.getItem('govchat-suggestion-auto-advance:' + window.__saHarness.settings.user.id)), '1', 'exact user-suffixed key');
    await modal(page).getByRole('button', { name: 'Sluiten' }).click();

    // 4. characterisation a spelling row disappears from the sidebar once accepted, because AuteurPane recomputes the rows from
    //    `content` and canAccept (Origineel still in the text) now fails, so there is no handled entry and no "Ongedaan maken" for it.
    await selectTab(page, 'spelling');
    await openRowModal(page, 'spelling-h2-block-h2-2');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(250);
    assert.ok((await cellText(page, 'h2')).includes('dit te akkoord gaan.'), 'spelling accept applied');
    const spellingRows = (await sidebarRowIds(page)).filter((id) => id.startsWith('spelling-'));
    record('spelling_rows_after_accept', spellingRows);
    assert.deepEqual(spellingRows, [], 'the accepted spelling row is not listed as handled');
  },
};
