import { writable } from 'svelte/store';
import { UI_SETTINGS_KEY, storageKey } from '$lib/storageKeys.js';
import { storageGet, storageSet } from '$lib/safeStorage.js';

/**
 * Persisted UI settings and preferences.
 * Browser-only persistence via localStorage under `gs_ui_settings:<userId>` (storageKeys.js).
 *
 * `chatMode` stays in the shape for compatibility with stored settings, but is forced to `false`
 * (the chat-mode toggle is removed and the runner is unreachable).
 */
const DEFAULT_SETTINGS = {
    chatMode: false,
    autoAi: false,
    showDdMetrics: false,
};

function readStored() {
    const isBrowser = typeof window !== 'undefined';
    let initial = DEFAULT_SETTINGS;
    if (isBrowser) {
        const stored = storageGet(storageKey(UI_SETTINGS_KEY));
        if (stored) {
            try {
                initial = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
            } catch (e) {
                console.warn('Failed to parse UI settings:', e);
            }
        }
    }
    return { ...initial, chatMode: false };
}

function createUiSettingsStore() {
    const isBrowser = typeof window !== 'undefined';
    const { subscribe, set, update } = writable(readStored());

    const persist = (value) => {
        if (isBrowser) {
            storageSet(storageKey(UI_SETTINGS_KEY), JSON.stringify(value));
        }
    };

    return {
        subscribe,
        set: (value) => {
            const next = { ...value, chatMode: false };
            persist(next);
            set(next);
        },
        update: (fn) => {
            update((curr) => {
                const next = { ...fn(curr), chatMode: false };
                persist(next);
                return next;
            });
        },
        /** Toggle a specific boolean setting */
        toggle: (/** @type {keyof typeof DEFAULT_SETTINGS} */ key) => {
            update((curr) => {
                const next = { ...curr, [key]: !curr[key], chatMode: false };
                persist(next);
                return next;
            });
        },
        /** Re-reads the persisted value for the current storage user (called by `mount()` once the user id is known). */
        reload: () => {
            set(readStored());
        }
    };
}

export const uiSettings = createUiSettingsStore();
