/**
 * Bundle entry. Built as an IIFE named `SchrijfassistentApp`, the only
 * global the bundle creates: `window.SchrijfassistentApp.mount(container, { getToken, user, config, onClose })`
 * and `window.SchrijfassistentApp.unmount()`, wrapping Svelte 5's imperative `mount()` / `unmount()`
 * (https://svelte.dev/docs/svelte/imperative-component-api).
 */
import { mount as svelteMount, unmount as svelteUnmount } from 'svelte';
import App from './App.svelte';
import './styles/responsive.css'; // after App and its components: the responsive layout rules come last in the bundle's CSS
import { setRuntimeConfig, BUILD_HASH, BUILD_DATE } from '$lib/config.js';
import { setTokenProvider, abortAllRequests } from '$lib/apiClient.js';
import { setStorageUserId } from '$lib/storageKeys.js';
import { requireOpenWebUIUser } from '$lib/identityAdapter.js';
import { initHostBridge, teardownHostBridge, requestHostClose } from '$lib/hostBridge.js';
import { uiSettings } from '$lib/uiStore.js';
import { isAutoSaveEnabled, resetAutoSaveState, setAutosaveTornDown } from '$lib/autosaveStore.js';
import { resetStoreState } from '$lib/store.js';
import { resetStorageWarning } from '$lib/safeStorage.js';
import { clearAllWorkspaceTimers, setWorkspaceDisposed } from './lib/components/Workspace.svelte';
import { reloadSuggestionAutoAdvance } from '$lib/suggestionStore.js';

/** @type {Record<string, any> | null} */
let instance = null;
/** @type {HTMLElement | null} */
let mountedTarget = null;

/**
 * Host shortcuts: Open WebUI registers its global shortcuts on `document`. Keys that are
 * typed or pressed inside the application are never meant for them, so ctrl/meta chords and Shift+Esc stop here, at the
 * mount target (the node Svelte delegates its own events from, which has run its handlers by now), and do not bubble on
 * to `document`. Plain keys and Esc are left alone: `SuggestionModal` and `Workspace` (full-screen block) listen on `window`
 * for those and the host may keep its own plain-key behaviour. Browser default actions (copy, paste, undo, select all) are not touched.
 * @param {KeyboardEvent} e
 */
function stopHostShortcuts(e) {
    if (e.ctrlKey || e.metaKey || (e.shiftKey && e.key === 'Escape')) e.stopPropagation();
}

/**
 * Re-reads every persisted store for the storage user set by `mount()`; the stores are evaluated when the
 * IIFE loads, before the user id is known (storageKeys.js).
 */
function reloadStores() {
    uiSettings.reload();
    isAutoSaveEnabled.reload();
    reloadSuggestionAutoAdvance();
}

/**
 * @param {HTMLElement} target - the `.sa-root` container created by loader.js
 * @param {{ getToken?: () => string, user?: object, config?: object, onClose?: () => void | Promise<void> }} props
 */
export function mount(target, props = {}) {
    if (!target || typeof target !== 'object' || !('appendChild' in target)) {
        throw new Error('SchrijfassistentApp.mount: target element required');
    }
    // Checked before anything is touched: a missing identity must be visible, not silently shared.
    const user = requireOpenWebUIUser(props.user);
    if (instance) {
        // One instance at a time; a second mount replaces the first.
        destroy();
    }
    // SAFETY: the styles are scoped under .sa-root; the container carries the class even if the host forgot it.
    target.classList.add('sa-root');
    // A fresh session: the teardown flags of an earlier `unmount()` are lifted.
    setWorkspaceDisposed(false);
    setAutosaveTornDown(false);
    resetStorageWarning();
    setRuntimeConfig(props.config || null);
    setTokenProvider(props.getToken || null);
    setStorageUserId(user.id);
    reloadStores();
    initHostBridge({ container: target, onClose: props.onClose });

    try {
        instance = svelteMount(App, {
            target,
            props: {
                user,
                rootEl: target,
                onClose: requestHostClose,
            },
        });
    } catch (e) {
        // Leave nothing behind (the host bridge observer) when the component tree fails to start.
        teardownHostBridge();
        instance = null;
        throw e;
    }
    mountedTarget = target;
    target.addEventListener('keydown', stopHostShortcuts);
    return instance;
}

function destroy() {
    const inst = instance;
    instance = null;
    if (mountedTarget) mountedTarget.removeEventListener('keydown', stopHostShortcuts);
    mountedTarget = null;
    teardownHostBridge();
    //: nothing of this session outlives it. Requests in flight are aborted and the
    // answers still on their way are invalidated (generation counter), the auto-AI, auto-title and autosave timers are
    // cleared, and the module state (bases, conflicts, queued saves, the in-memory database, the refused copies of the
    // user) is reset before another user can be mounted. The order matters: abort first, so nothing completes while the tree is torn down.
    abortAllRequests();
    clearAllWorkspaceTimers();
    setAutosaveTornDown(true);
    resetAutoSaveState();
    if (inst) svelteUnmount(inst, { outro: false });
    resetStoreState();
}

/** Unmounts the app; resolves when Svelte has torn the tree down. loader.js removes the container afterwards. */
export async function unmount() {
    if (!instance) return;
    destroy();
}

export const version = { hash: BUILD_HASH, date: BUILD_DATE };
