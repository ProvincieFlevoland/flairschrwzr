// How the browser reaches the app and becomes a user.
//
// The bundle runs in its dev harness (schrijfassistent/frontend/dev, `npm run dev:harness`): a page that stands in for
// Open WebUI. The harness loads manifest.json and the bundle like loader.js does and mounts it with the identity from
// the query string, so `login()` is a navigation:
//   ?api=<backend>&token=<bearer>&user=<id>&name=<name>&role=<admin|user>[&dark=1][&autostart=0]
// The app role follows identityAdapter.js: Open WebUI role admin -> beheerder, every other role -> auteur.
// The scenarios of the launcher card use the Open WebUI stand-in in hostsim/ instead (see lib/hostsim.mjs).
export function makeAdapter(env) {
  return new DevHarnessAdapter(env);
}

/** Open WebUI role for an app role of the scenarios (identityAdapter.js inverted). */
export function openWebUIRole(role) {
  return role === 'beheerder' ? 'admin' : 'user';
}

/** Deterministic user id for a scenario name: 'Test Auteur' -> 'test-auteur'. */
export function userIdFor(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const EXTERNAL = /https?:\/\/(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

async function waitForConfigLoaded(rec, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const done = rec.requests.filter((r) => /\/configurations\/[^/]+\/hoofdstukken\/data/.test(r.url) && r.doneTs);
    if (done.length) return;
    if (Date.now() - t0 > timeout) throw new Error('configuration (hoofdstukken/data) did not load within 20 s');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export class DevHarnessAdapter {
  constructor(env) { this.env = env; this.kind = 'dev-harness'; this.lastUser = null; }

  /** The harness URL for an identity. The bearer is what getToken() returns, an admin token for a beheerder; the backend verifies it at the Open WebUI stand-in. */
  url(user, { autostart = true } = {}) {
    const u = new URL(this.env.appUrl);
    u.searchParams.set('api', this.env.baseUrl);
    u.searchParams.set('token', user.openWebUIRole === 'admin' ? this.env.adminBearer : this.env.bearer);
    u.searchParams.set('user', user.id);
    u.searchParams.set('name', user.name);
    u.searchParams.set('role', user.openWebUIRole);
    if (!autostart) u.searchParams.set('autostart', '0');
    return u.toString();
  }

  identity({ name = 'Test Auteur', role = 'auteur', id = null } = {}) {
    return { name, role, id: id || userIdFor(name), openWebUIRole: openWebUIRole(role) };
  }

  /** Waits for the mount and for the configuration load: until `hoofdstukken/data` has answered, a new nota has no chapters. */
  async waitMounted(page, rec) {
    await page.waitForSelector('#sa-container.sa-root .user-badge', { timeout: 20000 });
    if (rec) await waitForConfigLoaded(rec);
  }

  /**
   * Everyone lands on the nota overview (identityAdapter.js homeViewFor). The configurator scenarios start in the admin
   * view, so for a beheerder this opens it through the header's "Beheerdersweergave" button, the way a beheerder does;
   * `landing: true` on the identity keeps the view the app itself landed on.
   */
  async openHomeView(page, u) {
    if (u.role !== 'beheerder' || u.landing) return;
    await page.getByRole('button', { name: 'Beheerdersweergave' }).click();
    await page.waitForSelector('[class*="admin-dashboard"]', { timeout: 20000 });
  }

  /** Opens the harness and mounts the default user. */
  async open(page, { rec = null, user = null } = {}) {
    const u = user || this.identity();
    this.lastUser = u;
    await page.goto(this.url(u), { waitUntil: 'domcontentloaded' });
    await this.waitMounted(page, rec);
    await this.openHomeView(page, u);
  }

  /** "Login" = mount with this identity: a navigation to the harness URL with the identity in the query string. */
  async login(page, { name = 'Test Auteur', role = 'auteur', id = null, landing = false } = {}, { rec = null } = {}) {
    const u = { ...this.identity({ name, role, id }), landing };
    this.lastUser = u;
    await page.goto(this.url(u), { waitUntil: 'domcontentloaded' });
    await this.waitMounted(page, rec);
    await this.openHomeView(page, u);
    return { name, role, id: u.id };
  }

  async enter(page, user, opts = {}) { return this.login(page, user, opts); }

  /** A reload re-mounts the same identity (the harness reads it from the query string). */
  async reloadAndLogin(page, user, opts = {}) {
    const u = { ...this.identity(user || this.lastUser || {}), landing: !!(user || this.lastUser || {}).landing };
    if (this.lastUser && u.id === this.lastUser.id) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await this.waitMounted(page, opts.rec);
      await this.openHomeView(page, u);
      return { name: u.name, role: u.role, id: u.id };
    }
    return this.login(page, user, opts);
  }

  isExternal(url) { return EXTERNAL.test(url); }
}
