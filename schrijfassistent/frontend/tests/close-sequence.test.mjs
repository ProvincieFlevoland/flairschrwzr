// tests for the close sequence and the identity guard of mount().
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { needsCloseConfirmation, runCloseSequence } from '../src/lib/closeSequence.js';
import { requireOpenWebUIUser, mapOpenWebUIUser } from '../src/lib/identityAdapter.js';

describe('close confirmation', () => {
    it('is asked for a pending or in-flight save only', () => {
        assert.equal(needsCloseConfirmation('pending'), true);
        assert.equal(needsCloseConfirmation('saving'), true);
        for (const s of ['idle', 'success', 'error', undefined, null]) assert.equal(needsCloseConfirmation(s), false, String(s));
    });
});

describe('runCloseSequence', () => {
    it('saves, then clears the timers, then hands over to the host', async () => {
        const order = [];
        await runCloseSequence({
            autosave: async () => { order.push('autosave'); },
            reset: () => order.push('reset'),
            afterSave: () => order.push('afterSave'),
            onClose: async () => { order.push('onClose'); },
        });
        assert.deepEqual(order, ['autosave', 'reset', 'afterSave', 'onClose']);
    });

    it('clears the timers BEFORE the save, so none fires during a slow save', async () => {
        const order = [];
        let release;
        const gate = new Promise((r) => { release = r; });
        const done = runCloseSequence({
            beforeSave: () => order.push('beforeSave'),
            autosave: async () => { order.push('autosave:start'); await gate; order.push('autosave:end'); },
            reset: () => order.push('reset'),
            afterSave: () => order.push('afterSave'),
            onClose: async () => { order.push('onClose'); },
        });
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(order, ['beforeSave', 'autosave:start'], 'the timers are gone while the PUT is still in flight');
        release();
        await done;
        assert.deepEqual(order, ['beforeSave', 'autosave:start', 'autosave:end', 'reset', 'afterSave', 'onClose']);
    });

    it('clears the timers even when the save fails, and survives a throwing beforeSave', async () => {
        const order = [];
        const orig = console.error; console.error = () => {};
        try {
            await runCloseSequence({
                beforeSave: () => { order.push('beforeSave'); throw new Error('boom'); },
                autosave: async () => { order.push('autosave'); throw new Error('HTTP 500'); },
                reset: () => order.push('reset'),
                onClose: () => order.push('onClose'),
            });
        } finally { console.error = orig; }
        assert.deepEqual(order, ['beforeSave', 'autosave', 'reset', 'onClose']);
    });

    it('still clears the timers and closes when the save fails', async () => {
        const order = [];
        const orig = console.error; console.error = () => {};
        try {
            await runCloseSequence({
                autosave: async () => { throw new Error('HTTP 500'); },
                reset: () => order.push('reset'),
                onClose: () => order.push('onClose'),
            });
        } finally { console.error = orig; }
        assert.deepEqual(order, ['reset', 'onClose']);
    });

    it('survives a failing onClose and a missing onClose', async () => {
        const orig = console.error; console.error = () => {};
        try {
            await runCloseSequence({ autosave: async () => {}, reset: () => {}, onClose: async () => { throw new Error('x'); } });
            await runCloseSequence({ autosave: async () => {}, reset: () => {}, onClose: null });
        } finally { console.error = orig; }
    });

    it('waits for a slow save before it closes', async () => {
        const order = [];
        let release;
        const gate = new Promise((r) => { release = r; });
        const done = runCloseSequence({
            autosave: async () => { await gate; order.push('saved'); },
            reset: () => order.push('reset'),
            onClose: () => order.push('onClose'),
        });
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(order, []);
        release();
        await done;
        assert.deepEqual(order, ['saved', 'reset', 'onClose']);
    });
});

describe('identity guard of mount()', () => {
    it('rejects a missing user or a user without id', () => {
        for (const u of [undefined, null, {}, { id: '' }, { id: '   ' }, 'abc', { name: 'x', role: 'admin' }]) {
            assert.throws(() => requireOpenWebUIUser(u), /user with an id is required/, JSON.stringify(u));
        }
    });
    it('maps a valid user like mapOpenWebUIUser', () => {
        const u = { id: 'u1', email: 'a@b.nl', name: 'A', role: 'admin' };
        assert.deepEqual(requireOpenWebUIUser(u), mapOpenWebUIUser(u));
        assert.equal(requireOpenWebUIUser(u).role, 'beheerder');
        assert.equal(requireOpenWebUIUser({ id: 'u2' }).role, 'auteur');
    });
});

describe('App.svelte wiring of the close sequence', () => {
    it('passes the timer clearer as beforeSave and does not clear the timers in reset', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
        const call = src.slice(src.indexOf('await runCloseSequence({'), src.indexOf('onClose,\n            });'));
        assert.match(call, /beforeSave:\s*\(\)\s*=>\s*\{[^}]*clearAllWorkspaceTimers\(\);[^}]*setAutosaveTornDown\(true\);/s, 'the auto-AI and auto-title timers are cleared, and the autosave debounce disabled, before the save');
        const reset = call.slice(call.indexOf('reset:'), call.indexOf('afterSave:'));
        assert.doesNotMatch(reset, /clearAllWorkspaceTimers/, 'not a second time, and not only after the save');
    });
});
