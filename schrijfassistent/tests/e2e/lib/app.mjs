// Page helpers for the Schrijfassistent DOM. Selectors are the app's own
// global classes and attributes (`.editor-cell[data-block-id]`, `.cell-content`, `.pane-tab[data-tab]`,
// `.suggestion-highlight.source-*`, `[data-sidebar-suggestion-id]`, `button[role=switch]`); CSS-module
// classes are hashed and are matched with `[class*="name"]` only where nothing else exists.
import assert from 'node:assert/strict';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------- recorder
/** Records every request/response of a context: {method,url,ts,postData,headers,status,doneTs,body?}. */
export function attachRecorder(context, env) {
  const rec = { requests: [], external: [], dialogs: [], consoleErrors: [] };
  context.on('request', (req) => {
    const url = req.url();
    const entry = { method: req.method(), url, ts: Date.now(), postData: req.postData(), headers: req.headers(), status: null, doneTs: null, body: null, failed: false };
    req.__rec = entry;
    rec.requests.push(entry);
  });
  context.on('response', async (res) => {
    const e = res.request().__rec; if (!e) return;
    e.status = res.status();
    if (/\/api\/v1\//.test(e.url)) { try { e.body = await res.text(); } catch { e.body = null; } }
    e.doneTs = Date.now();     // set last: callers treat doneTs as "status and body are in"
  });
  context.on('requestfailed', (req) => { const e = req.__rec; if (e) { e.failed = true; e.doneTs = Date.now(); } });
  context.on('page', (page) => wirePage(page, rec));
  rec.filter = (pred) => rec.requests.filter(pred);
  rec.api = (method, pathRe, since = 0) => rec.requests.filter((r) => r.method === method && pathRe.test(r.url) && r.ts >= since);
  rec.mark = () => Date.now();
  return rec;
}

export function wirePage(page, rec) {
  page.on('dialog', async (d) => { rec.dialogs.push({ type: d.type(), message: d.message(), ts: Date.now() }); await d.accept(); });
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
}

/** Aborts (and records) requests to third-party hosts, so a run needs no internet; the third-party scenario reads rec.external. */
export async function blockExternal(context, env, rec) {
  const own = new Set([new URL(env.appUrl).host, new URL(env.baseUrl).host]);
  await context.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (own.has(new URL(url).host)) return route.continue();
    rec.external.push(url);
    return env.blockExternal ? route.abort() : route.continue();
  });
}

/** Waits until `pred(rec)` holds (polling), else throws with `what`. */
export async function waitFor(pred, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms) waiting for ${what}`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------- browser storage
/**
 * Reads a localStorage value of the app. The app suffixes every key with `:<Open WebUI user id>` (storageKeys.js).
 * The suffixed key is resolved from the harness identity (`window.__saHarness.settings.user.id`) when present,
 * else the only `key:*` entry; a plain key is returned as it is.
 */
export async function localGet(page, key) {
  return page.evaluate((k) => {
    const plain = localStorage.getItem(k);
    if (plain !== null) return plain;
    const uid = window.__saHarness?.settings?.user?.id;
    if (uid) return localStorage.getItem(`${k}:${uid}`);
    const keys = Object.keys(localStorage).filter((x) => x.startsWith(k + ':'));
    return keys.length === 1 ? localStorage.getItem(keys[0]) : null;
  }, key);
}
export async function localGetJson(page, key, fallback = null) {
  const v = await localGet(page, key);
  if (v === null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ------------------------------------------------------------------------------- views
/** Waits for a view of the app (a selector) and returns 'real'. */
export async function waitView(page, sel, { timeout = 20000 } = {}) {
  await page.waitForSelector(sel, { timeout });
  return 'real';
}

// ------------------------------------------------------------------------------- dashboard
export function notaItem(page, title) {
  return page.locator('.nota-list-item').filter({ has: page.locator('h3', { hasText: title }) }).first();
}

/** Selects a nota on the dashboard by title and opens it in the editor; returns the editor's first cell. */
export async function openNota(page, title, { role = 'auteur' } = {}) {
  await page.waitForSelector('.nota-list-item', { timeout: 20000 });
  await notaItem(page, title).click();
  const label = role === 'reviewer' ? 'Bekijk & Toets Nota' : 'Bewerk Nota';
  await page.getByRole('button', { name: label }).click();
  await page.waitForSelector('.editor-cell[data-block-id]', { timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector('.editor-cell .cell-content'));
}

/** Status chip class without the generic `sa-` prefix (the bundle writes `.sa-badge-*`). */
export function chipClassOf(classList) {
  const c = [...classList].find((x) => /^(sa-)?badge-/.test(x)) || '';
  return c.replace(/^sa-/, '');
}

export async function backToDashboard(page) {
  await page.getByRole('button', { name: 'Terug naar Overzicht' }).click();
  await page.waitForSelector('.dashboard-layout', { timeout: 20000 });
}

// ------------------------------------------------------------------------------- editor
export const cellSel = (chapterId) => `.editor-cell[data-block-id="block-${chapterId}"]`;
export const cell = (page, chapterId) => page.locator(cellSel(chapterId));
export const cellContent = (page, chapterId) => page.locator(`${cellSel(chapterId)} .cell-content`);

export async function cellHtml(page, chapterId) { return cellContent(page, chapterId).evaluate((el) => el.innerHTML); }
/** textContent of a cell body, U+00A0 -> space, without the structural newline text nodes around the paragraphs. */
export async function cellText(page, chapterId) { return cellContent(page, chapterId).evaluate((el) => el.textContent.replace(/\u00a0/g, ' ').replace(/^\n+|\n+$/g, '')); }

/** Puts the caret at the end of a cell body (click in the cell, then End). */
export async function focusCell(page, chapterId) {
  await cellContent(page, chapterId).click();
  await page.keyboard.press('End');
}

/** Replaces the body of a cell by typing (select all inside the contenteditable, then type). Returns the time of the last keystroke. */
export async function typeInCell(page, chapterId, text, { replace = true, delay = 0 } = {}) {
  await cellContent(page, chapterId).click();
  if (replace) await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay });
  return Date.now();
}

/** Clicks the per-cell "AI analyse" button and waits until the three agents are done. */
export async function runCellAi(page, rec, chapterId) {
  const since = Date.now();
  const btn = page.locator(`${cellSel(chapterId)} .cell-ai-btn`);
  await cell(page, chapterId).locator('.cell-header').hover();   // .cell-actions are opacity 0 / pointer-events none unless the cell is hovered or focused
  await btn.click();
  await waitFor(() => {
    const calls = rec.api('POST', /generate-agent-response/, since).filter((r) => new URL(r.url).searchParams.get('chapter_id') === chapterId);
    return calls.length >= 3 && calls.every((c) => c.doneTs) ? calls : null;
  }, { timeout: 30000, what: `3 agent calls for ${chapterId}` });
  // not the label text: BlockEditor.applyHighlight() calls root.normalize() on the whole cell, which can leave Svelte's label text node stale
  await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && !b.disabled && !b.classList.contains('cell-ai-btn--analyzing'); }, `${cellSel(chapterId)} .cell-ai-btn`, { timeout: 15000, polling: 100 });
  await sleep(200);
}

export function agentCalls(rec, since = 0) {
  return rec.api('POST', /generate-agent-response/, since).map((r) => {
    const u = new URL(r.url);
    // the app sends the message as JSON body
    let userMessage = null;
    try { userMessage = r.postData ? JSON.parse(r.postData).user_message ?? null : null; } catch { userMessage = null; }
    return { ...r, assignment: u.searchParams.get('assignment'), chapter: u.searchParams.get('chapter_id'), userMessage };
  });
}

export function putCalls(rec, notaId, since = 0) {
  return rec.api('PUT', new RegExp(`/storage/notas/${escapeRe(encodeURIComponent(notaId))}(\\?|$)`), since);
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Highlight spans inside a cell: [{source, id, text}]. */
export async function highlights(page, chapterId) {
  return cell(page, chapterId).evaluate((root) =>
    [...root.querySelectorAll('.suggestion-highlight')].map((el) => ({
      id: el.dataset.id,
      source: [...el.classList].find((c) => c.startsWith('source-'))?.slice(7) || null,
      text: el.textContent,
      active: el.classList.contains('suggestion-highlight-active'),
      hovered: el.classList.contains('hovered-from-sidebar'),
    })));
}

export async function nonB1Words(page, chapterId) {
  return cell(page, chapterId).evaluate((root) => [...root.querySelectorAll('.non-b1-word')].map((el) => el.textContent));
}

// ------------------------------------------------------------------------------- sidebar
export async function selectTab(page, tab) {
  await page.locator(`.pane-tab[data-tab="${tab}"]`).click();
  await page.waitForFunction((t) => document.querySelector(`.pane-tab[data-tab="${t}"]`)?.classList.contains('active'), tab);
  await sleep(150); // highlight repaint happens after tick()
}

export async function sidebarRowIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-sidebar-suggestion-id]')].map((el) => el.getAttribute('data-sidebar-suggestion-id')));
}

export const sidebarRow = (page, id) => page.locator(`[data-sidebar-suggestion-id="${id}"]`).first();

// ------------------------------------------------------------------------------- suggestion modal
export const modal = (page) => page.locator('[role="dialog"][aria-labelledby="suggestion-modal-title"]');
export const modalAccept = (page) => modal(page).getByRole('button', { name: 'Accepteren' });
export const modalDeny = (page) => modal(page).getByRole('button', { name: 'Afwijzen' });

/** Which highlight id the open modal belongs to (the span carries `suggestion-highlight-active`). */
export async function activeHighlightId(page) {
  return page.evaluate(() => document.querySelector('.suggestion-highlight-active')?.dataset.id || null);
}

export async function openRowModal(page, id) {
  await sidebarRow(page, id).click();
  await modal(page).waitFor({ state: 'visible', timeout: 10000 });
  await sleep(150);
}

// ------------------------------------------------------------------------------- header
export async function openSettings(page) {
  const gear = page.locator('button[title="Instellingen"]');
  await gear.waitFor({ state: 'visible' });
  await gear.click({ force: true });        // force: skip the stability check (icon font blocked, the button can re-layout while loading)
  await page.waitForSelector('button[role="switch"]');
}
export async function closeSettings(page) {
  await page.locator('button[title="Instellingen"]').click({ force: true });
  await page.waitForSelector('button[role="switch"]', { state: 'detached' });
}
export function settingSwitch(page, labelText) {
  return page.locator('label').filter({ hasText: labelText }).locator('button[role="switch"]');
}
/** Sets a header setting switch to `on` (opens and closes the menu). Returns the previous state. */
export async function setSetting(page, labelText, on) {
  await openSettings(page);
  const sw = settingSwitch(page, labelText);
  const before = (await sw.getAttribute('aria-checked')) === 'true';
  if (before !== on) await sw.click();
  assert.equal((await sw.getAttribute('aria-checked')) === 'true', on, `switch ${labelText}`);
  await closeSettings(page);
  return before;
}

export async function headerStatusIcon(page) {
  return page.evaluate(() => {
    if (document.querySelector('i[title="Automatisch opgeslagen"]')) return 'success';
    if (document.querySelector('i[title="Autosave mislukt"]')) return 'error';
    return 'none';
  });
}

export async function toasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent.trim()));
}

/**
 * A button by its visible label. Icons can render as placeholder text glyphs (`+`, `\u2190`, `\u2713`, `!` ...) when the icon font is
 * blocked, and those become part of the accessible name, so `getByRole(.., { exact: true })` does not match; this accepts up to a
 * few non-letter characters before the label.
 */
export function buttonByText(page, label) {
  return page.locator('button').filter({ hasText: new RegExp(`^[^A-Za-z\\u00c0-\\u00ff0-9]{0,3}${escapeRe(label)}$`) });
}

/**
 * Waits for a notice to the user that matches `re`: a toast. Resolves with the text.
 */
export async function waitNotice(page, rec, env, re, { timeout = 10000, since = 0 } = {}) {
  return waitFor(async () => {
    return (await toasts(page)).find((t) => re.test(t)) || null;
  }, { timeout, what: `notice ${re}` });
}

// ------------------------------------------------------------------------------- misc
/**
 * Plain text the way Workspace.copyAll builds it (utils/clipboardText.js): `${title}\n${body}` per block, the title alone when
 * the body is empty, blocks joined by a blank line. Paragraphs and `<br>` become line breaks, entities are decoded and NBSP is a
 * space, a deliberately empty paragraph stays an empty line, and an untouched template instruction (`<p><i>instructie</i></p>`
 * whose text is one of `placeholders` or a generic placeholder phrase) is left out.
 */
export function copyAllText(contentHtml, placeholders = []) {
  const parts = contentHtml.split(/(?=<h2 class="dynamic-chapter")/);
  const blocks = [];
  for (const part of parts) {
    const m = part.match(/^<h2 class="dynamic-chapter"[^>]*>([\s\S]*?)<\/h2>([\s\S]*)$/);
    if (!m) { if (part.trim()) blocks.push({ title: 'Algemeen', body: part }); continue; }
    blocks.push({ title: m[1].replace(/<[^>]*>/g, ''), body: m[2] });
  }
  const decode = (s) => s.replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ').replace(/ /g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();
  const generic = [/^schrijf hier een korte, krachtige titel\.?$/i, /^start met typen\.{0,3}$/i];
  const wanted = new Set(placeholders.map(norm).filter(Boolean));
  return blocks.map((b) => {
    let html = b.body.replace(/<p>\s*<(i|em)>([\s\S]*?)<\/\1>\s*<\/p>/gi, (all, _tag, inner) => {
      if (/<[a-z]/i.test(inner)) return all;
      const t = norm(inner);
      return wanted.has(t) || generic.some((re) => re.test(t)) ? '' : all;
    });
    html = html.replace(/<(p|div)>(?:\s|<br\s*\/?>|&nbsp;)*<\/\1>/gi, '<p>\u0001</p>');
    const text = decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|li|h[1-6]|blockquote|pre|tr)(\s[^>]*)?>/gi, '\n').replace(/<[^>]*>/g, ''));
    const body = text.replace(/[ \t]*\n[ \t\n]*/g, '\n').trim().split('\u0001').join('');
    const title = b.title.trim();
    return body ? `${title}\n${body}` : title;
  }).join('\n\n');
}

export function wordCount(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }
