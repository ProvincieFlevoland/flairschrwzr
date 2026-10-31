// Unit test for the conflict base of store.js (see schrijfassistent/API.md, optimistic concurrency).
// store.js imports through the `$lib` alias, which plain Node does not know: a resolve hook maps it.
import { register } from 'node:module';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib') + '/').href;
const hooks = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith('$lib/')) return next(${JSON.stringify(lib)} + spec.slice(5), ctx);
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

let store;
let api;
before(async () => {
    store = await import('../src/lib/store.js');
    api = await import('../src/lib/apiClient.js');
});

function deferred() {
    /** @type {(v: any) => void} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

describe('store.js optimistic concurrency base', () => {
    it('advances the base to the lastModified that was sent, not to a later in-place edit', async () => {
        const calls = [];
        const gate = deferred();
        globalThis.fetch = async (url, init) => {
            calls.push({ url, headers: init.headers, body: init.body });
            if (calls.length === 1) await gate.promise;
            return { ok: true, status: 200 };
        };
        api.setTokenProvider(null);
        const nota = { id: 'n-a', title: 't', lastModified: '2026-01-01T00:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-a', lastModified: '2025-12-31T00:00:00.000Z' }]);

        const first = store.syncNotaToAzure('n-a');
        // the user types while the PUT is in flight: Workspace mutates the live object
        nota.lastModified = '2026-01-01T00:00:05.000Z';
        gate.resolve();
        await first;
        assert.equal(calls[0].headers['X-Nota-Base-Modified'], '2025-12-31T00:00:00.000Z');
        assert.equal(JSON.parse(calls[0].body).lastModified, '2026-01-01T00:00:00.000Z');
        assert.equal(store.getNotaBase('n-a'), '2026-01-01T00:00:00.000Z');

        await store.syncNotaToAzure('n-a');
        assert.equal(calls[1].headers['X-Nota-Base-Modified'], '2026-01-01T00:00:00.000Z');
        assert.equal(store.getNotaBase('n-a'), '2026-01-01T00:00:05.000Z');
        assert.equal(store.isNotaSyncing('n-a'), false);
    });

    it('serialises two overlapping saves of the same nota', async () => {
        const calls = [];
        const gate = deferred();
        let inFlight = 0;
        let maxInFlight = 0;
        globalThis.fetch = async (url, init) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            calls.push({ headers: init.headers, body: JSON.parse(init.body) });
            if (calls.length === 1) await gate.promise;
            inFlight -= 1;
            return { ok: true, status: 200 };
        };
        const nota = { id: 'n-b', title: 'one', lastModified: '2026-02-01T00:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-b', lastModified: '2026-01-31T00:00:00.000Z' }]);

        const first = store.syncNotaToAzure('n-b');
        nota.title = 'two';
        nota.lastModified = '2026-02-01T00:00:09.000Z';
        const second = store.syncNotaToAzure('n-b');
        assert.equal(store.isNotaSyncing('n-b'), true);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(calls.length, 1, 'the second save waits for the first');
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(maxInFlight, 1);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].headers['X-Nota-Base-Modified'], '2026-02-01T00:00:00.000Z', 'the second save carries the base the first advanced');
        assert.equal(calls[1].body.title, 'two');
        assert.equal(store.getNotaBase('n-b'), '2026-02-01T00:00:09.000Z');
        assert.equal(store.isNotaSyncing('n-b'), false);
    });

    it('a failed save does not block the next one and keeps the base', async () => {
        let n = 0;
        globalThis.fetch = async () => {
            n += 1;
            return n === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
        };
        const nota = { id: 'n-c', lastModified: '2026-03-01T00:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-c', lastModified: '2026-02-28T00:00:00.000Z' }]);
        const a = store.syncNotaToAzure('n-c');
        const b = store.syncNotaToAzure('n-c');
        await assert.rejects(a, /HTTP 500/); // 409 has its own test (conflict-autosave.test.mjs); a plain failure keeps this one's meaning
        await b;
        assert.equal(store.getNotaBase('n-c'), '2026-03-01T00:00:00.000Z');
        assert.equal(store.isNotaSyncing('n-c'), false);
    });
});
