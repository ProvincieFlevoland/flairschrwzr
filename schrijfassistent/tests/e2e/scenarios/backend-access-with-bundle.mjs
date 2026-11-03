import assert from 'node:assert/strict';
import { openNota, waitFor } from '../lib/app.mjs';
import { IDENTITIES, requireHostsim, newHostUser } from '../lib/hostsim.mjs';

const API = '/apps/schrijfassistent/api/v1/storage';
async function call(base, path, { token, headers = {}, method = 'GET', body } = {}) {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`; if (body) h['content-type'] = 'application/json';
  const r = await fetch(base + API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

/** Backend access end to end WITH the embedded bundle, behind the host stand-in. An auteur works in the real bundle (list, open, save with
 *  the base header) with every call authenticated; an anonymous call, an unknown bearer and an `X-Access-Token` header alone are 401; a
 *  verified auteur may read the configurations and is refused (403) on a configuration write, a verified admin is not; a beheerder gets
 *  the configurator without a single 401 or 403. */
export default {
  id: 'backend-access-with-bundle', title: 'backend access with the embedded bundle (bearer only, role check)', timeout: 150000,
  async run(ctx) {
    const base = requireHostsim(ctx);
    const { auteur, beheerder, outsider } = IDENTITIES;

    // 1. the door: health stays open, everything else needs a verified Open WebUI user
    assert.equal((await fetch(base + '/apps/schrijfassistent/health')).status, 200, 'health is open');
    for (const [what, opts] of [['no credentials', {}], ['an X-Access-Token header only', { headers: { 'X-Access-Token': 'x' } }], ['unknown bearer', { token: 'not-a-token' }]]) {
      const r = await call(base, '/notas', opts);
      assert.equal(r.status, 401, `${what}: 401`);
    }
    assert.equal((await call(base, '/notas', { token: outsider.token })).status, 200, 'any verified user reads the notas');
    assert.equal((await call(base, '/configurations', { token: outsider.token })).status, 200, 'any verified user reads the configurations');

    // 2. the role check on a configuration write: auteur 403 with the Dutch text, admin 200 (same value written back)
    const meta = await call(base, '/configurations/GS-nota%20v5/metadata', { token: beheerder.token });
    assert.equal(meta.status, 200); const isActive = meta.json.isActive === true;
    const denied = await call(base, '/configurations/GS-nota%20v5/metadata', { token: auteur.token, method: 'PATCH', body: { isActive } });
    assert.equal(denied.status, 403); assert.match(denied.json.detail, /Alleen een beheerder/);
    assert.equal((await call(base, '/configurations/GS-nota%20v5/metadata', { token: beheerder.token, method: 'PATCH', body: { isActive } })).status, 200, 'the admin may');
    assert.equal((await call(base, '/configurations/GS-nota%20v5/metadata', { token: auteur.token, method: 'PATCH', body: { isActive } , headers: { 'X-Access-Token': 'x' } })).status, 403, 'a legacy header does not help');

    // 3. the auteur in the real bundle: every call authenticated, a save carries the base header and succeeds
    const p = await newHostUser(ctx, base, auteur);
    await p.load();
    assert.equal((await p.clickCard()).outcome, 'embedded');
    await p.waitDashboard();
    const title = (await call(base, '/notas/n1760000000001', { token: auteur.token })).json.title;
    await openNota(p.page, title);
    await p.page.getByRole('button', { name: 'Opslaan' }).click();
    const put = await waitFor(() => p.requests.find((r) => r.method === 'PUT' && /\/notas\/n1760000000001/.test(r.url) && r.status), { what: 'PUT of the nota', timeout: 20000 });
    assert.equal(put.status, 200, 'the save is accepted');
    assert.ok(put.baseModified, 'the save carries X-Nota-Base-Modified');
    assert.equal(put.auth, `Bearer ${auteur.token}`);
    const bad = p.apiRequests().filter((r) => r.status && r.status >= 400);
    assert.deepEqual(bad.map((r) => `${r.method} ${r.url} ${r.status}`), [], 'no 4xx or 5xx on any backend call of the auteur');
    assert.ok(p.apiRequests().every((r) => r.auth === `Bearer ${auteur.token}` && !r.xAccess), 'bearer only');
    await p.page.getByRole('button', { name: 'Terug naar Overzicht' }).click();
    await p.closeApp();

    // 4. the beheerder: lands on the overview, and the configurator loads under the role check without a 401 or a 403
    const a = await newHostUser(ctx, base, beheerder);
    await a.load();
    assert.equal((await a.clickCard()).outcome, 'embedded');
    await a.waitDashboard();
    await a.page.getByRole('button', { name: 'Beheerdersweergave' }).click();
    await a.page.getByRole('button', { name: /Ga naar nota overzicht/ }).first().waitFor({ timeout: 25000 });
    const abad = a.apiRequests().filter((r) => r.status && r.status >= 400);
    assert.deepEqual(abad.map((r) => `${r.method} ${r.url} ${r.status}`), [], 'no refusal for the beheerder');
    ctx.record('beheerder_api_calls', a.apiRequests().length);
  },
};
