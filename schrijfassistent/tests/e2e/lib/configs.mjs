// Helpers of the configurator scenarios: configurations seeded through the API under test ids, their list items in the
// admin view, and the hostile strings of the hostile-content scenario. Every id starts with `test-` so nothing here can collide
// with the seeded `GS-nota v5`.
import { fixture, STORAGE } from './api.mjs';

export const stamp = () => Date.now();

/** The payloads of the hostile scenarios. Each one would run script or load something when it reached the DOM as markup. */
export const PAYLOADS = {
  img: '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">',
  script: '<script>window.__pwned=(window.__pwned||0)+1</script>',
  svg: '"><svg onload="window.__pwned=(window.__pwned||0)+1">',
  anchor: '<a href="javascript:window.__pwned=1">klik</a>',
  iframe: '<iframe src="http://canary.invalid/frame"></iframe>',
  beacon: '<img src="http://canary.invalid/beacon.png">',
  style: '<style>body{display:none}</style><div style="position:fixed;inset:0;background:red">x</div>',
};

/** The inner object (metadata + mappen) of the seeded v5 upload body. */
export function v5Inner() {
  return Object.values(fixture('config/GS-nota-v5.upload.json'))[0];
}

/**
 * An upload body `{ [id]: {...} }` derived from the v5 fixture. `mappen` entries replace the fixture's; `extra` is merged into the
 * metadata part. The fixture's woordenlijst is kept unless `mappen.woordenlijst` says otherwise.
 */
export function configBody(id, { name = id, isActive = false, mappen = {}, extra = {} } = {}) {
  const inner = v5Inner();
  return { [id]: { ...inner, name, isActive, ...extra, mappen: { ...inner.mappen, ...mappen } } };
}

export async function uploadConfig(api, body) {
  const r = await api.post(`${STORAGE}/upload-configuration`, body);
  if (!r.ok) throw new Error(`upload-configuration ${r.status}: ${r.text}`);
  return r.json;
}

export async function deleteConfig(api, id) {
  return api.delete(`${STORAGE}/configurations/${encodeURIComponent(id)}`);
}

export async function listConfigs(api) {
  const r = await api.get(`${STORAGE}/configurations`);
  return r.json?.configurations || [];
}

/** The row of a configuration in the list of the admin view (synced or local), found by its visible name. */
export const configItem = (page, name) => page.locator('[class*="config-selection-item"]').filter({ hasText: name }).first();

/** Number of requests of a recorder to a URL pattern, optionally since a time. */
export const count = (rec, method, re, since = 0) => rec.api(method, re, since).length;

/** A toast (role alert) that matches `re`. */
export async function waitToast(page, re, { timeout = 10000 } = {}) {
  const { waitFor } = await import('./app.mjs');
  const { toasts } = await import('./app.mjs');
  return waitFor(async () => (await toasts(page)).find((t) => re.test(t)) || null, { timeout, what: `toast ${re}` });
}
