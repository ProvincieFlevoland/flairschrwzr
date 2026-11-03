// Helpers for the launcher-card scenarios: they drive the host stand-in (hostsim/serve.mjs), which serves the real overlay
// loader.js and the real bundle in front of the backend, so a launcher click is the real click. The scenarios skip when no
// host stand-in runs (E2E_HOSTSIM_URL, or `hostsim_url` in the running file of dev/run-test-stack.sh).
import assert from 'node:assert/strict';
import { sleep } from './app.mjs';

export const IDENTITIES = {
  auteur: { token: 'auteur-token', email: 'auteur@example.test', name: 'Test Auteur', role: 'user' },
  beheerder: { token: 'beheerder-token', email: 'beheerder@example.test', name: 'Test Beheerder', role: 'admin' },
  outsider: { token: 'outsider-token', email: 'outsider@example.test', name: 'Outsider', role: 'user' },
};

/** Origin of the host stand-in, or '' when none runs. */
export function hostsimUrl(env) {
  return String(env.hostsimUrl || '').replace(/\/$/, '');
}

export function requireHostsim(ctx) {
  const base = hostsimUrl(ctx.env);
  if (!base) ctx.skip('no host stand-in: start dev/run-test-stack.sh (part hostsim) and use its running file, or set E2E_HOSTSIM_URL');
  return base;
}

async function json(base, path, init) {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text };
}

/** The host stand-in's own endpoints. */
export const hostApi = {
  /** The published card list, as the browser fetches it. */
  published: (base) => json(base, '/static/apps.json'),
  requests: (base) => json(base, '/__hostsim/requests'),
  reset: (base) => json(base, '/__hostsim/reset'),
};

/**
 * A browser context of its own for one user of the host stand-in (the scenario's default context blocks every host other than the
 * app and the API). `identity` is one of IDENTITIES, or null for a user without a token. Returns { page, context, requests, open }
 * where `requests` lists every request of the context with its time and bearer header.
 */
export async function newHostUser(ctx, base, identity, { dark = false } = {}) {
  const browser = ctx.context.browser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'nl-NL' });
  ctx.cleanup(async () => { try { await context.close(); } catch { /* closed */ } });
  const requests = [];
  const byRequest = new Map();
  context.on('request', (req) => {
    const h = req.headers();
    const e = { ts: Date.now(), method: req.method(), url: req.url(), auth: h['authorization'] || '', xAccess: h['x-access-token'] || '', baseModified: h['x-nota-base-modified'] || '', postData: req.postData(), status: null };
    byRequest.set(req, e); requests.push(e);
  });
  context.on('response', (res) => { const e = byRequest.get(res.request()); if (e) e.status = res.status(); });
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); if (m.type() === 'warning') consoleWarnings.push(m.text()); });
  const user = { page, context, requests, identity, consoleErrors, consoleWarnings, base };
  user.load = async () => {
    const q = new URLSearchParams(); if (identity) q.set('token', identity.token); if (dark) q.set('dark', '1');
    await page.goto(`${base}/?${q}`);
    await page.waitForSelector('#al-sidebar-btn', { timeout: 15000 });
  };
  /** Opens the launcher and clicks the Schrijfassistent card. Resolves with what happened: 'embedded' | 'iframe' | 'external' | 'nothing' ('iframe' and 'external' are other cards' targets and would be a failure for this one). */
  user.clickCard = async ({ waitMs = 8000 } = {}) => {
    await page.locator('#al-sidebar-btn').click();
    await page.waitForSelector('.al-card[data-app-id="schrijfassistent"]', { timeout: 8000 });
    // the launcher refreshes the card list in the background; give that read a moment so the click sees the current list
    await sleep(400);
    const popupPromise = context.waitForEvent('page', { timeout: waitMs }).catch(() => null);
    const t0 = Date.now();
    await page.locator('.al-card[data-app-id="schrijfassistent"]').click();
    const deadline = t0 + waitMs;
    for (;;) {
      if (await page.locator('#sa-container.sa-root').count()) {
        await popupPromise.catch(() => null);
        return { outcome: 'embedded', ms: Date.now() - t0 };
      }
      const frame = page.locator('#iv-container iframe');
      if (await frame.count()) return { outcome: 'iframe', src: await frame.first().getAttribute('src'), ms: Date.now() - t0 };
      const popup = await Promise.race([popupPromise, sleep(150).then(() => undefined)]);
      if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); return { outcome: 'external', url: popup.url(), ms: Date.now() - t0, popup }; }
      if (Date.now() > deadline) return { outcome: 'nothing', ms: Date.now() - t0 };
    }
  };
  /** Waits until the embedded app shows its dashboard for the user (name in the header, the nota list loaded). */
  user.waitDashboard = async () => {
    await page.waitForSelector('#sa-container.sa-root', { timeout: 15000 });
    await page.getByText("Recente GS-Nota's").first().waitFor({ timeout: 20000 });
  };
  user.closeApp = async () => {
    await page.locator('[aria-label="Schrijfassistent sluiten"]').click();
    await page.waitForSelector('#sa-container', { state: 'detached', timeout: 10000 });
  };
  /** Requests of this context that fetched the bundle (manifest, js, css) or called the backend through the path rule. */
  user.bundleRequests = () => requests.filter((r) => /\/static\/apps\/schrijfassistent\//.test(r.url));
  user.apiRequests = () => requests.filter((r) => /\/apps\/schrijfassistent\/api\//.test(r.url));
  return user;
}

/** A user without a token must not load the bundle or call the backend: no request for either. */
export function assertNoBundle(user, what) {
  assert.deepEqual(user.bundleRequests().map((r) => r.url), [], `${what}: the bundle is never requested`);
  assert.deepEqual(user.apiRequests().map((r) => r.url), [], `${what}: the backend is never called`);
}
