import assert from 'node:assert/strict';
import { chipClassOf } from '../lib/app.mjs';

const FIXTURES = {
  'Parkeergarage provinciehuis — concept': { status: 'WIP', chip: 'badge-draft', label: 'Concept (WIP)' },
  'Subsidieplafond 2026 vaststellen': { status: 'Final-draft', chip: 'badge-review', label: 'Ter Review (Final-draft)' },
  'Benoeming lid Raad van Toezicht': { status: 'Final', chip: 'badge-success', label: 'Definitief (Final)' },
};

/** dashboard with the three fixture notas -> order by lastModified desc; chips WIP, Final-draft, Final. */
export default {
  id: 'dashboard-order-and-chips', title: 'dashboard order and status chips',
  async run({ page, adapter, api, record }) {
    const server = await api.listNotas();
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await page.waitForSelector('.nota-list-item');
    await page.waitForFunction((n) => document.querySelectorAll('.nota-list-item').length >= n, Math.min(server.length, 3));
    const items = (await page.locator('.nota-list-item').evaluateAll((els) => els.map((el) => ({
      title: el.querySelector('h3')?.textContent.trim(),
      chipClasses: [...(el.querySelector('h3 + span')?.classList || [])],
      chipText: el.querySelector('h3 + span')?.textContent.trim() || '',
    })))).map((i) => ({ ...i, chipClass: chipClassOf(i.chipClasses) }));
    record('dashboard_titles', items.map((i) => i.title));
    // every listed nota in lastModified desc order (NotaDashboard.sortNotasByRecent)
    const byTitle = new Map(server.map((n) => [n.title, n]));
    const times = items.map((i) => Date.parse(byTitle.get(i.title)?.lastModified || 0));
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], `order at ${i}: ${items[i - 1].title} (${times[i - 1]}) before ${items[i].title} (${times[i]})`);
    // the three fixtures, chips and relative order
    const idx = (t) => items.findIndex((i) => i.title === t);
    const order = Object.keys(FIXTURES).map(idx);
    assert.ok(order.every((i) => i >= 0), `all three fixture notas listed: ${JSON.stringify(order)}`);
    assert.ok(order[0] < order[1] && order[1] < order[2], 'WIP (10-22) before Final-draft (10-21) before Final (10-20)');
    for (const [title, f] of Object.entries(FIXTURES)) {
      const it = items[idx(title)];
      assert.equal(it.chipClass, f.chip, `${title}: chip class`);
      assert.equal(it.chipText, f.label, `${title}: chip label`);
    }
  },
};
