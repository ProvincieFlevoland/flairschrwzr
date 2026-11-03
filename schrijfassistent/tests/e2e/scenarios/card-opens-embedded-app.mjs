import assert from 'node:assert/strict';
import { sleep } from '../lib/app.mjs';
import { IDENTITIES, requireHostsim, hostApi, newHostUser, assertNoBundle } from '../lib/hostsim.mjs';

/** The card opens the embedded app for every authenticated user. The published card carries no mode and no list. A user with a token
 *  (auteur or beheerder) gets the bundle and a bearer token on every backend call and no new tab is opened; a user without a token gets
 *  neither the bundle nor a new tab and the loader logs why. Runs the real loader.js and bundle in the host stand-in. */
export default {
  id: 'card-opens-embedded-app', title: 'the card opens the embedded app for every authenticated user', timeout: 120000,
  async run(ctx) {
    const base = requireHostsim(ctx);
    const { auteur, beheerder, outsider } = IDENTITIES;

    // 1. the published card
    const pub = await hostApi.published(base);
    assert.equal(pub.status, 200);
    const card = pub.body.apps.find((a) => a.id === 'schrijfassistent');
    assert.ok(card, 'the card is published');
    assert.equal(card.url, '/');
    for (const gone of ['mode', 'embedded_for_emails', 'embedded_for_roles']) assert.ok(!(gone in card.config), `${gone} is not in the published card`);
    assert.ok(!/sha256:/.test(pub.text), 'no hashed list is published any more');

    // 2. every authenticated identity: embedded, bearer on every call
    for (const [label, who] of [['outsider', outsider], ['auteur', auteur]]) {
      const u = await newHostUser(ctx, base, who);
      await u.load();
      const res = await u.clickCard();
      assert.equal(res.outcome, 'embedded', `${label}: the card opens the embedded app`);
      await u.waitDashboard();
      const api = u.apiRequests();
      assert.ok(api.length > 0 && api.every((r) => r.auth === `Bearer ${who.token}` && !r.xAccess), `${label}: bearer only on every backend call`);
      assert.ok(await u.page.getByText(who.name).first().isVisible(), `${label}: the header shows the display name`);
      await u.closeApp();
    }
    const a = await newHostUser(ctx, base, beheerder);
    await a.load();
    assert.equal((await a.clickCard()).outcome, 'embedded', 'beheerder: embedded as well');
    await a.waitDashboard();
    await a.page.getByRole('button', { name: 'Beheerdersweergave' }).first().waitFor({ timeout: 20000 });
    await a.closeApp();

    // 3. no token: nothing opens, nothing is fetched, the reason is logged
    const anon = await newHostUser(ctx, base, null);
    await anon.load();
    const res = await anon.clickCard();
    assert.equal(res.outcome, 'nothing', 'without an identity the card opens nothing');
    await sleep(1000);
    assertNoBundle(anon, 'anonymous');
    assert.ok(anon.consoleWarnings.some((w) => /Geen Open WebUI token|Geen identiteit/.test(w)), 'the reason is logged');

  },
};
