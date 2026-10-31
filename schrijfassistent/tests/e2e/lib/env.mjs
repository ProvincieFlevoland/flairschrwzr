// Environment of an e2e run.
//
//   E2E_BASE_URL         backend origin                                  [running file backend_url, else http://localhost:8011]
//   E2E_APP_URL          page the browser opens: the bundle's dev harness [running file dev_url, else http://localhost:3000/]
//   E2E_BEARER           token of a user with the role user (an auteur)   [test-user-token]
//   E2E_ADMIN_BEARER     token of a user with the role admin (a beheerder) [test-admin-token]
//   E2E_HOSTSIM_URL      the Open WebUI stand-in with the real loader.js  [running file hostsim_url]; the card scenarios skip without it
//   E2E_EXPECTED_VERSION SOFTWARE_VERSION_TAG the bundle was built with; the version scenario compares when set []
//   AI_MOCK_LOG          call log of the AI mock (dev/mock)               [running file ai_mock_log]
//   E2E_HEADLESS         1 | 0                                            [1]
//   E2E_SLOWMO           ms per action                                    [0]
//   E2E_BLOCK_EXTERNAL   1 | 0  abort third-party hosts                   [1] (the scenario "no third-party requests" records the attempts either way)
//   E2E_ONLY             comma list of scenario ids                       []  (or --only on the command line)
//   E2E_RUNNING_FILE     JSON written by dev/run-test-stack.sh            [dev/.running-test-stack.json]
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(here, '..');
export const SA_DIR = path.resolve(E2E_DIR, '../..');
export const DEV_DIR = path.join(SA_DIR, 'dev');
export const REPO = path.resolve(SA_DIR, '..');

function readJson(f) {
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

export function loadEnv(argv = process.argv.slice(2)) {
  const running = readJson(process.env.E2E_RUNNING_FILE || path.join(DEV_DIR, '.running-test-stack.json'));
  const baseUrl = (process.env.E2E_BASE_URL || running.backend_url || 'http://localhost:8011').replace(/\/$/, '');
  const only = (process.env.E2E_ONLY || argValue(argv, '--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    baseUrl,
    appUrl: process.env.E2E_APP_URL || running.dev_url || 'http://localhost:3000/',
    bearer: process.env.E2E_BEARER || 'test-user-token',
    adminBearer: process.env.E2E_ADMIN_BEARER || 'test-admin-token',
    hostsimUrl: (process.env.E2E_HOSTSIM_URL || running.hostsim_url || '').replace(/\/$/, ''),
    expectedVersion: process.env.E2E_EXPECTED_VERSION || '',
    aiMockLog: process.env.AI_MOCK_LOG || running.ai_mock_log || path.join(DEV_DIR, '.ai-mock-calls.jsonl'),
    headless: (process.env.E2E_HEADLESS || '1') !== '0' && !argv.includes('--headed'),
    slowMo: Number(process.env.E2E_SLOWMO || 0),
    blockExternal: (process.env.E2E_BLOCK_EXTERNAL || '1') !== '0',
    only,
    running,
  };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : '';
}

export function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
