#!/usr/bin/env node
// End-to-end tests: browser scenarios driven by the Playwright library through a small runner (no @playwright/test).
// One fresh browser context per scenario (empty localStorage), one JSON report per run.
//
//   node tests/e2e/run.mjs                      all scenarios
//   node tests/e2e/run.mjs --only autosave      a subset (scenario ids, comma separated; E2E_ONLY works too)
//   node tests/e2e/run.mjs --headed             watch it
//
// Environment: see lib/env.mjs. Report: tests/e2e/reports/e2e-<timestamp>.json (git-ignored).
// Exit code: 1 when a scenario fails, 2 on a harness error (browser, backend), else 0.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, E2E_DIR, stamp } from './lib/env.mjs';
import { loadPlaywright } from './lib/pw.mjs';
import { makeAdapter } from './lib/adapter.mjs';
import { Api } from './lib/api.mjs';
import { MockLog } from './lib/mocklog.mjs';
import { attachRecorder, blockExternal } from './lib/app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv();

export class Skip extends Error { constructor(reason) { super(reason); this.name = 'Skip'; } }

async function loadScenarios() {
  const dir = path.join(here, 'scenarios');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const f of files) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    out.push(m.default);
  }
  return out;
}

function selected(all) {
  if (!env.only.length) return all;
  return all.filter((s) => env.only.some((o) => s.id === o));
}

async function main() {
  const { pw, from, version } = await loadPlaywright();
  const scenarios = selected(await loadScenarios());
  if (!scenarios.length) { console.error(`no scenario matches ${env.only.join(',')}`); process.exit(2); }
  const adapter = makeAdapter(env);
  const api = new Api(env);
  const mockLog = new MockLog(env.aiMockLog);
  const h = await api.get('/health');
  if (!h.ok) { console.error(`backend ${env.baseUrl} not healthy: ${h.status} ${h.text}`); process.exit(2); }

  const browser = await pw.chromium.launch({ headless: env.headless, slowMo: env.slowMo });
  console.log(`e2e app=${env.appUrl} api=${env.baseUrl} playwright=${version} (${from}) mock-log=${mockLog.available ? env.aiMockLog : 'n/a'}`);
  const results = [];
  const t0 = Date.now();
  for (const s of scenarios) {
    const r = await runOne(browser, s, { adapter, api, mockLog });
    results.push(r);
    const tag = r.outcome.toUpperCase().padEnd(5);
    const extra = r.outcome === 'skip' ? `  (${r.reason})` : r.outcome === 'fail' ? `\n        ${r.error.split('\n').slice(0, 6).join('\n        ')}` : '';
    console.log(`  ${tag}  ${s.id.padEnd(34)} ${s.title}  [${(r.duration_ms / 1000).toFixed(1)}s]${extra}`);
  }
  await browser.close();

  const counts = { passed: results.filter((r) => r.outcome === 'pass').length, failed: results.filter((r) => r.outcome === 'fail').length, skipped: results.filter((r) => r.outcome === 'skip').length };
  mkdirSync(path.join(E2E_DIR, 'reports'), { recursive: true });
  const file = path.join(E2E_DIR, 'reports', `e2e-${stamp()}.json`);
  writeFileSync(file, JSON.stringify({ app_url: env.appUrl, base_url: env.baseUrl, playwright: version, timestamp: new Date().toISOString(), duration_ms: Date.now() - t0, counts, results }, null, 2));
  console.log(`  passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}  report: ${file}`);
  process.exit(counts.failed ? 1 : 0);
}

async function runOne(browser, s, shared) {
  const t0 = Date.now();
  const props = {};
  const cleanups = [];
  const context = await browser.newContext({ viewport: { width: 1480, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'], locale: 'nl-NL' });
  const rec = attachRecorder(context, env);
  await blockExternal(context, env, rec);
  const page = await context.newPage();            // dialogs/console are wired by the recorder's context 'page' event
  const a = shared.adapter;
  const adapter = {   // bound to this context's recorder so login() can wait for the configuration load
    kind: a.kind, isExternal: (u) => a.isExternal(u),
    open: (p, o = {}) => a.open(p, { ...o, rec }), login: (p, u) => a.login(p, u, { rec }), enter: (p, u) => a.enter(p, u, { rec }), reloadAndLogin: (p, u) => a.reloadAndLogin(p, u, { rec }),
    get lastUser() { return a.lastUser || null; },
  };
  const ctx = {
    env, page, context, rec, props, adapter, api: shared.api, mockLog: shared.mockLog,
    record: (k, v) => { props[k] = v; },
    skip: (reason) => { throw new Skip(reason); },
    cleanup: (fn) => cleanups.push(fn),
    newPage: () => context.newPage(),
  };
  let outcome = 'pass', error = null, reason = null;
  try {
    await withTimeout(s.run(ctx), s.timeout || 90000, s.id);
  } catch (e) {
    if (e instanceof Skip) { outcome = 'skip'; reason = e.message; }
    else {
      outcome = 'fail'; error = (e && e.stack) || String(e);
      try { mkdirSync(path.join(E2E_DIR, 'reports/shots'), { recursive: true }); await page.screenshot({ path: path.join(E2E_DIR, 'reports/shots', `${s.id}.png`), fullPage: true }); } catch { /* page gone */ }
    }
  }
  for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { props.cleanup_error = String(e); } }
  try { await context.close(); } catch { /* ignore */ }
  return { id: s.id, title: s.title, outcome, duration_ms: Date.now() - t0, reason, error, properties: props, console_errors: rec.consoleErrors.slice(0, 20) };
}

function withTimeout(p, ms, id) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`scenario ${id} exceeded ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

main().catch((e) => { console.error(e); process.exit(2); });
