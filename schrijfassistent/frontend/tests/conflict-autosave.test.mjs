// Unit tests of the 409 handling (store.js, autosaveStore.js), the autosave debounce and its retries, the
// per-user cache keys and the conflict copy. Timers run on node's mock clock, so the 10 s debounce and the 5 s retry
// delay cost nothing. store.js and autosaveStore.js import through the `$lib` alias, which plain Node does not know.
import { register } from 'node:module';
import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib') + '/').href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec.startsWith('$lib/')) return next(${JSON.stringify(lib)} + spec.slice(5), ctx);
  return next(spec, ctx);
}`));

// a browser-ish storage, so the per-user keys and the conflict copy can be read back
const mem = new Map();
const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
globalThis.localStorage = localStorage;
globalThis.window = { localStorage };

let store, api, auto, keys, notifications, notes;
before(async () => {
    store = await import('../src/lib/store.js');
    api = await import('../src/lib/apiClient.js');
    auto = await import('../src/lib/autosaveStore.js');
    keys = await import('../src/lib/storageKeys.js');
    const n = await import('../src/lib/notificationStore.js');
    notifications = n.notifications;
    notes = () => {
        let v; const unsub = notifications.subscribe((x) => { v = x; }); unsub(); return v.map((t) => t.message);
    };
});

function put(status, calls) {
    return async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
        return { ok: status >= 200 && status < 300, status };
    };
}

beforeEach(() => {
    mem.clear();
    api.setTokenProvider(null);
    keys.setStorageUserId('u-1');
    notifications.set([]);
    auto.resetAutoSaveState();
});

describe('409 handling in store.js', () => {
    it('sends the loaded base, answers a 409 with NotaConflictError and one toast, and keeps the local copy', async () => {
        const calls = [];
        globalThis.fetch = put(409, calls);
        const nota = { id: 'n-409a', title: 'mijn versie', lastModified: '2026-05-01T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-409a', lastModified: '2026-05-01T09:00:00.000Z' }]);
        await assert.rejects(store.syncNotaToAzure('n-409a'), (e) => e.name === 'NotaConflictError' && e.status === 409 && e.reported === true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].headers['X-Nota-Base-Modified'], '2026-05-01T09:00:00.000Z');
        assert.equal(notes().filter((m) => m === store.CONFLICT_MESSAGE).length, 1, 'one conflict toast');
        assert.equal(store.isNotaConflicted('n-409a'), true);
        assert.equal(store.getNotaBase('n-409a'), '2026-05-01T09:00:00.000Z', 'the base does not advance on a refusal');
        const stash = localStorage.getItem('gs_nota_conflict:u-1:n-409a');
        assert.ok(stash, 'the refused local version is kept in the per-user cache');
        assert.equal(JSON.parse(stash).title, 'mijn versie');
    });

    it('does not send the nota again while it is in conflict, and does not repeat the toast', async () => {
        const calls = [];
        globalThis.fetch = put(409, calls);
        const nota = { id: 'n-409b', lastModified: '2026-05-02T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-409b', lastModified: '2026-05-02T09:00:00.000Z' }]);
        await assert.rejects(store.syncNotaToAzure('n-409b'));
        await assert.rejects(store.syncNotaToAzure('n-409b'), (e) => e.name === 'NotaConflictError' && e.reported === false);
        assert.equal(calls.length, 1, 'the second save sends nothing');
        assert.equal(notes().length, 1, 'no second toast');
    });

    it('a reload of the list clears the conflict and replaces the base', async () => {
        const calls = [];
        globalThis.fetch = put(409, calls);
        const nota = { id: 'n-409c', lastModified: '2026-05-03T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-409c', lastModified: '2026-05-03T09:00:00.000Z' }]);
        await assert.rejects(store.syncNotaToAzure('n-409c'));
        store.rememberNotaBase([{ id: 'n-409c', lastModified: '2026-05-03T09:30:00.000Z' }]);
        assert.equal(store.isNotaConflicted('n-409c'), false);
        globalThis.fetch = put(200, calls);
        await store.syncNotaToAzure('n-409c');
        assert.equal(calls[1].headers['X-Nota-Base-Modified'], '2026-05-03T09:30:00.000Z');
        assert.equal(store.getNotaBase('n-409c'), '2026-05-03T10:00:00.000Z');
    });

    it('sends no header for a nota that was never loaded (first save), and a 200 advances the base', async () => {
        const calls = [];
        globalThis.fetch = put(200, calls);
        const nota = { id: 'n-new', lastModified: '2026-05-04T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        await store.syncNotaToAzure('n-new');
        assert.equal('X-Nota-Base-Modified' in calls[0].headers, false);
        assert.equal(store.getNotaBase('n-new'), '2026-05-04T10:00:00.000Z');
    });

    it('a delete forgets the base and the conflict', async () => {
        const calls = [];
        globalThis.fetch = put(409, calls);
        const nota = { id: 'n-del', lastModified: '2026-05-05T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-del', lastModified: '2026-05-05T09:00:00.000Z' }]);
        await assert.rejects(store.syncNotaToAzure('n-del'));
        store.forgetNotaBase('n-del');
        assert.equal(store.isNotaConflicted('n-del'), false);
        assert.equal(store.getNotaBase('n-del'), undefined);
    });
});

describe('autosave debounce, retries and conflicts (autosaveStore.js)', () => {
    it('saves once, 10 s after the last edit, and not before', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let saves = 0;
            const cb = async () => { saves += 1; };
            auto.startDebounceTimer('n-x', cb);
            mock.timers.tick(9999);
            await Promise.resolve();
            assert.equal(saves, 0, 'nothing before 10 s');
            auto.startDebounceTimer('n-x', cb);                 // a new edit restarts the countdown
            mock.timers.tick(9999);
            await Promise.resolve();
            assert.equal(saves, 0, 'the restart moved the deadline');
            mock.timers.tick(1);
            await new Promise((r) => setImmediate(r));
            assert.equal(saves, 1, 'exactly one save at 10 s after the last edit');
        } finally { mock.timers.reset(); }
    });

    it('retries a failing save twice, 5 s apart, then reports the failure', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let tries = 0;
            auto.startDebounceTimer('n-y', async () => { tries += 1; throw new Error('HTTP 500'); });
            const origErr = console.error; console.error = () => {};
            try {
                mock.timers.tick(10000);
                await new Promise((r) => setImmediate(r));
                assert.equal(tries, 1);
                mock.timers.tick(5000);
                await new Promise((r) => setImmediate(r));
                assert.equal(tries, 2);
                mock.timers.tick(5000);
                await new Promise((r) => setImmediate(r));
                assert.equal(tries, 3, 'three attempts in all (MAX_RETRIES 2)');
            } finally { console.error = origErr; }
            assert.ok(notes().some((m) => m.startsWith('Automatisch opslaan mislukt')), 'the failure toast');
        } finally { mock.timers.reset(); }
    });

    it('a 409 is not retried and does not add a second toast; the status ends in error', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const calls = [];
            globalThis.fetch = put(409, calls);
            const nota = { id: 'n-z', lastModified: '2026-06-01T10:00:00.000Z' };
            store.dbStore.set({ notas: [nota], users: [], configurations: [] });
            store.rememberNotaBase([{ id: 'n-z', lastModified: '2026-06-01T09:00:00.000Z' }]);
            auto.startDebounceTimer('n-z', () => store.syncNotaToAzure('n-z'));
            mock.timers.tick(10000);
            await new Promise((r) => setImmediate(r));
            let status; auto.autoSaveStatus.subscribe((v) => { status = v; })();
            assert.equal(status, 'error', 'the status icon shows the failure at once (it returns to idle after 5 s)');
            const msgs = notes();
            assert.equal(msgs.filter((m) => m === store.CONFLICT_MESSAGE).length, 1);
            assert.equal(msgs.some((m) => /poging|Automatisch opslaan mislukt/.test(m)), false, 'no retry or generic failure toast');
            mock.timers.tick(5000);           // the retry delay of a failing save would elapse here
            await new Promise((r) => setImmediate(r));
            assert.equal(calls.length, 1, 'one PUT, no retry');
        } finally { mock.timers.reset(); }
    });

    it('the immediate save (nota switch, close) does not add the generic toast after a reported 409', async () => {
        const calls = [];
        globalThis.fetch = put(409, calls);
        const nota = { id: 'n-i', lastModified: '2026-06-02T10:00:00.000Z' };
        store.dbStore.set({ notas: [nota], users: [], configurations: [] });
        store.rememberNotaBase([{ id: 'n-i', lastModified: '2026-06-02T09:00:00.000Z' }]);
        await auto.triggerImmediateAutoSave('n-i', () => store.syncNotaToAzure('n-i'));
        assert.equal(calls.length, 1);
        assert.deepEqual(notes(), [store.CONFLICT_MESSAGE]);
        // a second immediate save sends nothing and says why, once
        await auto.triggerImmediateAutoSave('n-i', () => store.syncNotaToAzure('n-i'));
        assert.equal(calls.length, 1);
        assert.equal(notes().filter((m) => m.startsWith('Niet opgeslagen: de nota is intussen')).length, 1, 'the text no longer says "lokaal opgeslagen"');
        assert.equal(notes().filter((m) => m.startsWith('Synchronisatie mislukt')).length, 0);
    });
});

describe('per-user browser cache', () => {
    it('keys carry the user id and a different user reads a different key', () => {
        keys.setStorageUserId('alice');
        assert.equal(keys.storageKey(keys.NOTA_DB_KEY), 'gs_nota_db:alice');
        assert.equal(keys.storageKey(keys.UI_SETTINGS_KEY), 'gs_ui_settings:alice');
        assert.equal(keys.storageKey(keys.AUTOSAVE_ENABLED_KEY), 'gs_autosave_enabled:alice');
        assert.equal(keys.storageKey(keys.SUGGESTION_AUTO_ADVANCE_KEY), 'govchat-suggestion-auto-advance:alice');
        keys.setStorageUserId('bob');
        assert.equal(keys.storageKey(keys.NOTA_DB_KEY), 'gs_nota_db:bob');
        keys.setStorageUserId('');
        assert.equal(keys.storageKey(keys.NOTA_DB_KEY), 'gs_nota_db:', 'the suffix is added also for an empty id (SAFETY)');
    });

    it('saveDB writes, and initDB reads, only the key of the current user', () => {
        keys.setStorageUserId('alice');
        store.dbStore.set({ notas: [{ id: 'a1', title: 'alice nota' }], users: [], configurations: [] });
        store.saveDB();
        assert.ok(localStorage.getItem('gs_nota_db:alice'));
        assert.equal(localStorage.getItem('gs_nota_db'), null, 'the plain key is never written');
        keys.setStorageUserId('bob');
        store.initDB();
        let db; store.dbStore.subscribe((v) => { db = v; })();
        assert.deepEqual(db.notas, [], 'bob starts with an empty cache and does not see alice\'s notas');
        assert.equal(localStorage.getItem('gs_nota_db:alice').includes('alice nota'), true);
    });

    it('the autosave toggle is per user', () => {
        keys.setStorageUserId('alice');
        auto.isAutoSaveEnabled.set(false);
        keys.setStorageUserId('bob');
        auto.isAutoSaveEnabled.reload();
        let v; auto.isAutoSaveEnabled.subscribe((x) => { v = x; })();
        assert.equal(v, true, 'bob has the default (enabled), alice switched it off');
        keys.setStorageUserId('alice');
        auto.isAutoSaveEnabled.reload();
        auto.isAutoSaveEnabled.subscribe((x) => { v = x; })();
        assert.equal(v, false);
    });
});
