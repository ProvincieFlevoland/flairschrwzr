// Resolves the Playwright *library* (not @playwright/test). Order: a `playwright` package resolvable from
// this directory, PLAYWRIGHT_LIB, the global npm root. Chromium comes from PLAYWRIGHT_BROWSERS_PATH (or Playwright's default cache).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function candidates() {
  const out = [];
  try { out.push(require.resolve('playwright')); } catch { /* not installed locally */ }
  if (process.env.PLAYWRIGHT_LIB) out.push(process.env.PLAYWRIGHT_LIB);
  try { out.push(path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright')); } catch { /* no npm */ }
  return out;
}

export async function loadPlaywright() {
  for (const c of candidates()) {
    const entry = c.endsWith('.js') ? c : path.join(c, 'index.js');
    if (!existsSync(entry)) continue;
    const mod = require(entry);
    return { pw: mod, from: c, version: safeVersion(c) };
  }
  throw new Error('playwright library not found: npm install playwright, or set PLAYWRIGHT_LIB=/path/to/node_modules/playwright');
}

function safeVersion(c) {
  try { return require(path.join(c.endsWith('.js') ? path.dirname(c) : c, 'package.json')).version; } catch { return 'unknown'; }
}
