import { writable } from 'svelte/store';
import { SUGGESTION_AUTO_ADVANCE_KEY, storageKey } from '$lib/storageKeys.js';
import { storageGet, storageSet } from '$lib/safeStorage.js';

/** @typedef {{ blockId: string, suggestionId: string }} SuggestionQueueEntry */

/**
 * Lightweight banner hint for the most recently accepted suggestion.
 * Only drives the 30-second "Geaccepteerd" banner in Workspace; the actual
 * undo data (originalText / appliedText) lives in `acceptedSuggestions` in Workspace.
 *
 * @typedef {{
 *   blockId: string,
 *   suggestionId: string,
 *   acceptedAt: number
 * }} LastAcceptedBannerEntry
 */

/** @type {import('svelte/store').Writable<LastAcceptedBannerEntry | null>} */
export const lastAcceptedEntry = writable(null);

/** @type {import('svelte/store').Writable<any>} */
export const activeSuggestion = writable(null);

/** @type {import('svelte/store').Writable<{id: string, source: 'text' | 'tab'} | null>} */
export const hoveredSuggestion = writable(null);

/**
 * localStorage key base for persisting whether the modal advances to the next filtered suggestion after accept/deny.
 * The stored key is suffixed with the user id (`storageKey()`, storageKeys.js).
 * @type {string}
 */
export const SUGGESTION_AUTO_ADVANCE_STORAGE_KEY = SUGGESTION_AUTO_ADVANCE_KEY;

/**
 * `localStorage` may exist in Node SSR (stub) without `getItem`; only use real browser Storage.
 * @returns {boolean}
 */
function canUseLocalStorage() {
    if (typeof window === 'undefined') return false;
    try {
        const ls = window.localStorage;
        return (
            ls != null &&
            typeof ls.getItem === 'function' &&
            typeof ls.setItem === 'function'
        );
    } catch {
        return false;
    }
}

/**
 * Reads persisted auto-advance preference from localStorage (browser only).
 * @returns {boolean}
 */
function readAutoAdvanceFromStorage() {
    if (!canUseLocalStorage()) return false;
    try {
        return storageGet(storageKey(SUGGESTION_AUTO_ADVANCE_STORAGE_KEY)) === '1';
    } catch {
        return false;
    }
}

/**
 * When `true`, after Accepteren or Afwijzen the workspace opens the next visible (filter-matched) suggestion in document order.
 * Persisted under {@link SUGGESTION_AUTO_ADVANCE_STORAGE_KEY}.
 */
export const suggestionAutoAdvance = writable(readAutoAdvanceFromStorage());

/** Re-reads the persisted preference for the current storage user (called by `mount()` once the user id is known). */
export function reloadSuggestionAutoAdvance() {
    suggestionAutoAdvance.set(readAutoAdvanceFromStorage());
}

/**
 * Updates auto-advance preference and persists to localStorage.
 * @param {boolean} value
 */
export function setSuggestionAutoAdvance(value) {
    suggestionAutoAdvance.set(value);
    if (!canUseLocalStorage()) return;
    try {
        storageSet(storageKey(SUGGESTION_AUTO_ADVANCE_STORAGE_KEY), value ? '1' : '0');
    } catch {
        /* quota / private mode */
    }
}

/**
 * Workspace registers this to open the next filtered suggestion (after `]`) without dismissing the current item.
 * @type {import('svelte/store').Writable<null | ((closedBlockId: string, closedSuggestionId: string) => void)>}
 */
export const suggestionNavigateNextRef = writable(null);

/**
 * Workspace registers this to open the previous filtered suggestion (after `[`) without dismissing the current item.
 * @type {import('svelte/store').Writable<null | ((closedBlockId: string, closedSuggestionId: string) => void)>}
 */
export const suggestionNavigatePrevRef = writable(null);

/**
 * Opens the suggestion modal with merged params; infers `source` from `highlightId` when omitted.
 * @param {Record<string, any>} params - Modal props; may include highlightId, blockId, onAccept, onDeny/onIgnore, source, etc.
 */
export const showSuggestionModal = (params) => {
    const hid = String(params.highlightId ?? '');
    const inferredSource =
        hid.startsWith('agent_structuur')
            ? 'structuur'
            : hid.startsWith('agent_b1')
              ? 'b1'
              : hid.startsWith('agent_woordenlijst')
                ? 'woordenlijst'
                : hid.startsWith('spelling')
                  ? 'spelling'
                  : null;
    activeSuggestion.set({
        id: Math.random().toString(36).substring(2, 9),
        ...params,
        onDeny: params.onDeny ?? params.onIgnore,
        source: params.source ?? inferredSource ?? 'b1'
    });
};
