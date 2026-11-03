// Audit of removed features (chat mode, legacy gauges): the removed
// gauge components are absent from the tree and nothing in src/ imports them, and the stored chat-mode setting is
// forced to false by uiStore (this guards the source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.(svelte|js|mjs|ts)$/.test(name)) yield p;
    }
}

test('the legacy gauge components are not in the bundle source', () => {
    assert.equal(existsSync(path.join(SRC, 'lib/components/ui/MetricsDashboard.svelte')), false);
    assert.equal(existsSync(path.join(SRC, 'lib/components/ui/CircleGauge.svelte')), false);
    const users = [];
    for (const file of walk(SRC)) {
        if (/import\s+(MetricsDashboard|CircleGauge)\b/.test(readFileSync(file, 'utf8'))) users.push(path.relative(SRC, file));
    }
    assert.deepEqual(users, []);
});

test('uiStore forces chatMode to false', () => {
    const src = readFileSync(path.join(SRC, 'lib/uiStore.js'), 'utf8');
    assert.match(src, /chatMode:\s*false/);
    assert.match(src, /\.\.\.value,\s*chatMode:\s*false/);
});

test('the chat runner and the uncalled triggerAllAgents are deleted from the pane and the workspace', () => {
    for (const f of ['lib/components/AuteurPane.svelte', 'lib/components/Workspace.svelte']) {
        const src = readFileSync(path.join(SRC, f), 'utf8');
        assert.doesNotMatch(src, /chatbot|\[Chatbot\]|chatMode|runChatbotAgents/i, `${f}: no chat runner`);
    }
    const pane = readFileSync(path.join(SRC, 'lib/components/AuteurPane.svelte'), 'utf8');
    assert.doesNotMatch(pane, /function triggerAllAgents\b/, 'AuteurPane.triggerAllAgents is gone');
});
