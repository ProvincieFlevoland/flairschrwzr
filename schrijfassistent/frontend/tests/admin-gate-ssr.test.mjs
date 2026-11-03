// The role gate of the configurator as behaviour, not as text. The real component is
// compiled by the project's own Vite configuration and rendered on the server with Svelte's `render`: an auteur gets the denied
// notice and none of the configurator, a beheerder gets the configurator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AdminDashboard renders the denied notice for every role except beheerder (SSR of the real component)', { timeout: 120000 }, async () => {
    const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
    try {
        const mod = await server.ssrLoadModule('/src/lib/components/AdminDashboard.svelte');
        const { render } = await server.ssrLoadModule('svelte/server');
        const html = (currentUser) => render(mod.default, { props: { currentUser } }).body;
        for (const user of [{ id: 'u', name: 'N', role: 'auteur' }, { id: 'u', name: 'N', role: 'reviewer' }, { id: 'u', name: 'N', role: 'admin' }, { id: 'u', name: 'N' }, null]) {
            const body = html(user);
            assert.match(body, /data-admin-denied/, JSON.stringify(user));
            assert.match(body, /Geen toegang/);
            assert.doesNotMatch(body, /sa-admin-dashboard/, 'none of the configurator is rendered');
        }
        const ok = html({ id: 'u', name: 'N', role: 'beheerder' });
        assert.doesNotMatch(ok, /data-admin-denied/);
        assert.match(ok, /sa-admin-dashboard/);
        // the way back to the overview ("Ga naar nota overzicht", data-action="work-as-author") lives in the Header, not here
    } finally {
        await server.close();
    }
});
