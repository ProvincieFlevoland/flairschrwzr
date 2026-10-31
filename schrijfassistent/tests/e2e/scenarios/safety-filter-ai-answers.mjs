import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, runCellAi, selectTab, sidebarRowIds, openRowModal, modal, modalAccept, cellHtml, cellText, cellContent, putCalls, agentCalls, waitFor, sleep, highlights } from '../lib/app.mjs';

const TEXT = 'Wij verzoeken u dit te accorderen. Daarna volgt de rest. [[mock:hostile]]';
const BAD_IN_CELL = ['<script', '<iframe', '<svg', '<img', '<a ', 'onerror', 'onload', 'javascript:', 'test-canary', '__pwned'];

/** Everything an element could use to run or load something, anywhere in the app (the logo `img` of the header is the app's own). */
async function leaks(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#sa-container');
    const sel = ['script', 'iframe', 'svg[onload]', 'img[src*="test-canary"]', '[onerror]', '[onload]', '[onclick]', 'a[href^="javascript:" i]', 'object', 'embed'];
    return { pwned: window.__pwned ?? null, elements: sel.filter((s) => root.querySelector(s)) };
  });
}

/** hostile AI answers. Each of the four review flows (structuur h1, Direct Duidelijk, taalreview, woordenlijst)
 *  answers with the `hostile` fixtures (img onerror, script, svg onload, iframe and anchor with javascript:, in Origineel, Tekst, Suggestie and Uitleg);
 *  the backend passes them through (contract tests). The text lookup of an applied suggestion (BlockEditor.suggestionTextForDomSearch, reached through
 *  replaceText with the Tekst or Suggestie of the row) and the structuur accept (BlockEditor.setContent) are the two places where AI text meets the filter
 *  (an Origineel with markup is never found in the plain text of the cell, so that row is dropped before it gets that far): nothing executes, no request goes to the canary host, the sidebar and the modal
 *  show the answers as text, the highlights still find their text, accepting replaces the text by the filtered text and the PUT carries no markup of the payload. */
export default {
  id: 'safety-filter-ai-answers', title: 'safety filter: hostile AI answers (all four flows) cannot run or load anything', timeout: 150000,
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('safety-filter-ai-answers', { content: notaHtml({ h1: `<p>${TEXT}</p>` }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    const T0 = await cellText(page, 'h1');

    // 1. structuur, Direct Duidelijk and taalreview through the cell's AI button; woordenlijst through the sidebar
    await runCellAi(page, rec, 'h1');
    const calls = agentCalls(rec).filter((c) => c.chapter === 'h1');
    assert.ok(calls.every((c) => c.userMessage.includes('[[mock:hostile]]')), 'the marker travels in user_message');
    await page.locator('button[aria-label^="Blok: Onderwerp"]').click();
    await selectTab(page, 'woordenlijst');
    const since = Date.now();
    await page.locator('.pane-list button[class*="btn-primary"]').first().click();
    await waitFor(() => agentCalls(rec, since).find((c) => c.assignment === 'agent_woordenlijst' && c.doneTs), { what: 'woordenlijst call' });
    await sleep(500);
    const answers = rec.api('POST', /generate-agent-response/).map((r) => JSON.parse(r.body));
    record('answers_with_payload', answers.filter((a) => /onerror=|onload=/.test(JSON.stringify(a))).length);
    assert.equal(answers.filter((a) => /onerror=|onload=/.test(JSON.stringify(a))).length, 4, 'all four answers carried a payload');
    let l = await leaks(page);
    assert.deepEqual(l, { pwned: null, elements: [] }, `nothing executed or loaded after the four answers: ${JSON.stringify(l)}`);
    assert.deepEqual(rec.external.filter((u) => u.includes('test-canary')), [], 'no request to the canary host');

    // 2. the sidebar rows exist and carry the answer as text; the highlights found the filtered originals
    const tabs = { spelling: 'spelling-h1-', b1: 'agent_b1-h1-', woordenlijst: 'agent_woordenlijst-h1-' };
    const rows = {};
    for (const [tab, prefix] of Object.entries(tabs)) {
      await selectTab(page, tab);
      rows[tab] = (await sidebarRowIds(page)).filter((id) => id.startsWith(prefix));
      assert.ok(rows[tab].length >= 1, `${tab}: at least one row (${JSON.stringify(await sidebarRowIds(page))})`);
    }
    record('rows', rows);
    await selectTab(page, 'b1');
    const hlB1 = await highlights(page, 'h1');
    assert.ok(hlB1.some((h) => h.source === 'b1' && h.text === 'Wij verzoeken u dit te accorderen.'), `the B1 highlight found the filtered original: ${JSON.stringify(hlB1)}`);
    await selectTab(page, 'spelling');
    assert.ok((await highlights(page, 'h1')).some((h) => h.source === 'spelling' && h.text === 'accorderen'), 'the taalreview highlight found "accorderen"');
    await selectTab(page, 'woordenlijst');
    assert.ok((await highlights(page, 'h1')).some((h) => h.source === 'woordenlijst' && h.text === 'verzoeken'), 'the woordenlijst highlight found "verzoeken"');
    for (const bad of BAD_IN_CELL) assert.ok(!(await cellHtml(page, 'h1')).includes(bad), `${bad} is not in the cell: ${await cellHtml(page, 'h1')}`);
    l = await leaks(page);
    assert.deepEqual(l, { pwned: null, elements: [] }, `nothing after the highlights: ${JSON.stringify(l)}`);

    // 3. accept B1 alternative 1, then undo: the filtered text goes in and the original comes back
    await selectTab(page, 'b1');
    await openRowModal(page, rows.b1[0]);
    assert.deepEqual(await leaks(page), { pwned: null, elements: [] }, 'opening the modal with the hostile answer runs nothing');
    await page.keyboard.press('1');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(300);
    const t1 = await cellText(page, 'h1');
    assert.ok(t1.includes('Wij vragen u dit goed te keuren.'), `B1 text applied: ${t1}`);
    for (const bad of ['<', 'canary', 'pwned', 'onerror']) assert.ok(!t1.includes(bad), `${bad} not in the text after accept: ${t1}`);
    for (const bad of BAD_IN_CELL) assert.ok(!(await cellHtml(page, 'h1')).includes(bad), `${bad} not in the cell after accept`);
    const handled = page.locator(`[data-sidebar-suggestion-id="${rows.b1[0]}"]`).first();
    await handled.locator('button').first().click();
    await page.getByRole('button', { name: 'Ongedaan maken' }).click();
    await sleep(300);
    const undone = await cellText(page, 'h1');
    assert.equal(undone, T0, 'undo restores the original text');

    // 4. accept the taalreview row
    await selectTab(page, 'spelling');
    await openRowModal(page, rows.spelling[0]);
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(300);
    const t2 = await cellText(page, 'h1');
    assert.ok(t2.includes('akkoord gaan'), `taalreview text applied: ${t2}`);
    for (const bad of ['<', 'canary', 'pwned']) assert.ok(!t2.includes(bad), `${bad} not in the text: ${t2}`);

    // 5. structuur accept: setContent replaces the whole cell with the AI text through the filter
    // (a structuur suggestion has no sidebar row; a click in the cell with structuur feedback opens its modal)
    await selectTab(page, 'structuur');
    await cellContent(page, 'h1').click();
    await modal(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(await leaks(page), { pwned: null, elements: [] }, 'opening the structuur modal with the hostile answer runs nothing');
    await modalAccept(page).click();
    await modal(page).waitFor({ state: 'hidden' });
    await sleep(500);
    const html3 = await cellHtml(page, 'h1');
    record('cell_html_after_structuur_accept', html3);
    assert.ok(html3.includes('<p>Opdracht te verlenen tot het bouwen van een parkeergarage.</p>'), `the safe markup of the answer is kept: ${html3}`);
    assert.ok(html3.includes('<p>Het subsidieplafond 2026 vast te stellen.</p>'));
    for (const bad of BAD_IN_CELL) assert.ok(!html3.includes(bad), `${bad} is gone from the cell after the structuur accept: ${html3}`);
    await sleep(800);
    l = await leaks(page);
    assert.deepEqual(l, { pwned: null, elements: [] }, `nothing after the structuur accept: ${JSON.stringify(l)}`);
    assert.deepEqual(rec.external.filter((u) => u.includes('test-canary')), [], 'no request to the canary host, ever');

    // 6. what is saved carries none of it
    const put = await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length && p[p.length - 1].doneTs && p[p.length - 1].postData.includes('Opdracht te verlenen') ? p[p.length - 1] : null; }, { timeout: 25000, what: 'autosave PUT after the structuur accept' });
    const saved = JSON.parse(put.postData).content;
    for (const bad of ['test-canary', 'onerror', 'onload', '<script', '<svg', '<iframe', 'javascript:', '__pwned']) assert.ok(!saved.includes(bad), `${bad} is not in the saved content`);
    const stored = (await api.getNota(nota.id)).content;
    for (const bad of ['test-canary', 'onerror', 'onload', '<script', '<svg', '<iframe', 'javascript:', '__pwned']) assert.ok(!stored.includes(bad), `${bad} is not in the stored content`);
  },
};
