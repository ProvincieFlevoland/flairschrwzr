import { writable, get } from 'svelte/store';
import { addNotification } from './notificationStore.js';
import { AUTOSAVE_ENABLED_KEY as AUTOSAVE_ENABLED_BASE_KEY, storageKey } from './storageKeys.js';
import { storageGet, storageSet } from './safeStorage.js';
import { getGeneration, isCurrentGeneration } from './apiClient.js';

/**
 * Autosave state management for automatic Azure Blob Storage sync.
 *
 * - isAutoSaveEnabled: User preference for autosave (persisted to localStorage under
 *   `gs_autosave_enabled:<userId>`, storageKeys.js)
 * - autoSaveStatus: Current autosave operation status
 * - lastAutoSaveTime: Timestamp of last successful autosave
 */

/** @typedef {'idle' | 'pending' | 'saving' | 'success' | 'error'} AutoSaveStatus */

/** The storage key for the current user (resolved at every access, the user id is set by `mount()`). */
const AUTOSAVE_ENABLED_KEY = () => storageKey(AUTOSAVE_ENABLED_BASE_KEY);
const AUTOSAVE_DEBOUNCE_MS = 10000; // 10 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000; // 5 seconds

/**
 * Get initial autosave enabled state from localStorage (through safeStorage: a blocked or full storage means the default).
 * @returns {boolean}
 */
function getInitialAutoSaveEnabled() {
    const stored = storageGet(AUTOSAVE_ENABLED_KEY());
    if (stored === null) return true; // Default enabled
    return stored === 'true';
}

// Store for autosave enabled/disabled toggle (persisted)
function createAutoSaveEnabledStore() {
    const { subscribe, set, update } = writable(getInitialAutoSaveEnabled());

    return {
        subscribe,
        set: (/** @type {boolean} */ value) => {
            storageSet(AUTOSAVE_ENABLED_KEY(), String(value));
            set(value);
            // Switched off: a countdown that was armed while it was on would fire nothing, and its `pending` status
            // would make the close confirmation treat the edits as "about to be saved" (closeSequence.js).
            if (!value) cancelDebounceTimer();
        },
        toggle: () => {
            let next;
            update((current) => {
                next = !current;
                storageSet(AUTOSAVE_ENABLED_KEY(), String(next));
                return next;
            });
            if (!next) cancelDebounceTimer();
        },
        /** Re-reads the persisted value for the current storage user (called by `mount()` once the user id is known). */
        reload: () => {
            set(getInitialAutoSaveEnabled());
        }
    };
}

export const isAutoSaveEnabled = createAutoSaveEnabledStore();

/** @type {import('svelte/store').Writable<AutoSaveStatus>} */
export const autoSaveStatus = writable('idle');

/** @type {import('svelte/store').Writable<number | null>} */
export const lastAutoSaveTime = writable(null);

// Internal state for debounce timer
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimerId = null;
/** @type {string | null} */
let currentNotaId = null;
/** @type {(() => Promise<void>) | null} */
let syncCallback = null;

/**
 * Teardown flag: set by the close sequence before the awaited save and by `unmount()`;
 * while it is set `startDebounceTimer` arms nothing, so an in-flight title or agent answer that arrives after the close
 * began cannot start a new debounce and a PUT for an app that is leaving. `mount()` clears it.
 */
let tornDown = false;
export function setAutosaveTornDown(value) {
    tornDown = !!value;
}

/** Bumped by `resetAutoSaveState`: a retry that was sleeping when the state was reset stops instead of sending. */
let resetGeneration = 0;

/**
 * An HTTP error that a retry cannot cure: 4xx other than 408, 425 and 429 (401 and 403 included). `store.js` puts the status on the error it throws.
 */
function isPermanentHttpError(error) {
    const st = error && typeof error.status === 'number' ? error.status : 0;
    return st >= 400 && st < 500 && st !== 408 && st !== 425 && st !== 429;
}

/** The text for a failed save that is not a 409 (the generic one, or the session text for 401/403). */
function failureMessage(error, generic) {
    const st = error && error.status;
    if (st === 401 || st === 403) return 'Opslaan niet toegestaan: je sessie is mogelijk verlopen. Laad de pagina opnieuw.';
    return generic;
}

/** A refused save because another client saved the nota first (store.js `NotaConflictError`). */
function isConflictError(error) {
    return !!error && error.name === 'NotaConflictError';
}

/**
 * Retry a function with a fixed, bounded delay (three attempts, 5 s apart; the original comment said exponential).
 * A 409 and a permanent 4xx are not retried, and a retry that was sleeping when the app was torn down or reset stops.
 * @param {() => Promise<void>} fn - The async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delayMs - Delay between retries
 * @returns {Promise<void>}
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, delayMs = RETRY_DELAY_MS) {
    let lastError;
    const gen = getGeneration();
    const resetGen = resetGeneration;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await fn();
            return; // Success - exit
        } catch (error) {
            lastError = error;
            // A 409 (store.js `NotaConflictError`) cannot succeed on a retry, the base stays stale. Give up at once:
            // no retry toast, no second and third PUT.
            if (isConflictError(error)) throw error;
            console.error(`Autosave attempt ${attempt + 1}/${maxRetries + 1} failed:`, error && error.name, error && error.status);
            if (isPermanentHttpError(error)) throw error;

            if (attempt < maxRetries) {
                // Show retry notification
                addNotification(
                    `Autosave mislukt, opnieuw proberen... (poging ${attempt + 2}/${maxRetries + 1})`,
                    'warning',
                    3000
                );
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delayMs));
                if (!isCurrentGeneration(gen) || resetGen !== resetGeneration) throw error;
            }
        }
    }

    // All retries failed
    throw lastError;
}

/**
 * Start or restart the autosave debounce timer.
 * With "Automatisch Opslaan" off nothing is armed and the status stays as it is: `pending` means a save is coming,
 * and the close confirmation relies on that (closeSequence.js `closeConfirmationKind` lets `pending` outrank
 * `unsaved`, and the close then saves without `force`, which sends nothing while autosave is off).
 * @param {string} notaId - The nota ID to autosave
 * @param {() => Promise<void>} callback - The sync function to call after debounce
 */
export function startDebounceTimer(notaId, callback) {
    // Cancel any existing timer
    cancelDebounceTimer();
    if (tornDown) return;
    if (!get(isAutoSaveEnabled)) return;

    // Store the callback and nota ID
    currentNotaId = notaId;
    syncCallback = callback;

    // Set status to pending
    autoSaveStatus.set('pending');

    // Start new timer
    debounceTimerId = setTimeout(async () => {
        const isEnabled = get(isAutoSaveEnabled); // the in-memory value: a full storage must not undo the toggle

        if (!isEnabled) {
            autoSaveStatus.set('idle');
            return;
        }

        autoSaveStatus.set('saving');

        try {
            if (syncCallback) {
                await retryWithBackoff(syncCallback);
            }
            autoSaveStatus.set('success');
            lastAutoSaveTime.set(Date.now());

            // Show success indicator briefly (no toast notification)
            setTimeout(() => {
                autoSaveStatus.set('idle');
            }, 1000);
        } catch (error) {
            autoSaveStatus.set('error');

            // A conflict was reported by the store (toast) and every further tick would repeat it: the status icon says it.
            if (!isConflictError(error)) {
                console.error('Autosave failed after all retries:', error && error.name, error && error.status);
                // Show error notification
                addNotification(
                    failureMessage(error, 'Automatisch opslaan mislukt. Gebruik de "Opslaan" knop om handmatig op te slaan.'),
                    'error',
                    6000
                );
            }

            // Reset to idle after error display
            setTimeout(() => {
                autoSaveStatus.set('idle');
            }, 5000);
        }
    }, AUTOSAVE_DEBOUNCE_MS);
}

/**
 * Cancel the pending autosave timer.
 */
export function cancelDebounceTimer() {
    if (debounceTimerId !== null) {
        clearTimeout(debounceTimerId);
        debounceTimerId = null;
    }

    // Only reset to idle if we were pending
    autoSaveStatus.update(status => {
        if (status === 'pending') return 'idle';
        return status;
    });
}

/**
 * Immediately trigger autosave (skip debounce).
 * Used for navigation-based autosave.
 * @param {string} notaId - The nota ID to autosave
 * @param {() => Promise<void>} callback - The sync function to call
 * @param {{ force?: boolean }} [opts] - `force` saves although autosave is switched off
 * @returns {Promise<void>}
 */
export async function triggerImmediateAutoSave(notaId, callback, opts = {}) {
    const isEnabled = get(isAutoSaveEnabled);

    // `opts.force`: the auteur chose "Opslaan en sluiten" with autosave off.
    if (!isEnabled && !opts.force) {
        return;
    }

    // Cancel any pending debounced save
    cancelDebounceTimer();

    autoSaveStatus.set('saving');

    try {
        await retryWithBackoff(callback);
        autoSaveStatus.set('success');
        lastAutoSaveTime.set(Date.now());

        // Show success indicator briefly (no toast notification)
        setTimeout(() => {
            autoSaveStatus.set('idle');
        }, 1000);
    } catch (error) {
        autoSaveStatus.set('error');

        // The store already showed the conflict toast for a refused save; the generic text stays for everything else
        // (and for a nota that is still in conflict, where nothing was sent and nothing was said this time).
        if (!(isConflictError(error) && error.reported)) {
            if (!isConflictError(error)) console.error('Immediate autosave failed after all retries:', error && error.name, error && error.status);
            // A nota in conflict sends nothing; "lokaal opgeslagen" would be wrong then (the stored version replaces the local one on reload).
            addNotification(
                isConflictError(error)
                    ? 'Niet opgeslagen: de nota is intussen door iemand anders gewijzigd. Kopieer je versie voordat je de nota opnieuw laadt.'
                    : failureMessage(error, 'Synchronisatie mislukt. Wijzigingen zijn lokaal opgeslagen.'),
                'warning',
                isConflictError(error) ? 8000 : 4000
            );
        }

        setTimeout(() => {
            autoSaveStatus.set('idle');
        }, 3000);
    }
}

/**
 * Reset autosave state (for cleanup or error recovery).
 */
export function resetAutoSaveState() {
    resetGeneration += 1;
    cancelDebounceTimer();
    autoSaveStatus.set('idle');
    currentNotaId = null;
    syncCallback = null;
}

/**
 * Get the current nota ID being autosaved.
 * @returns {string | null}
 */
export function getCurrentNotaId() {
    return currentNotaId;
}
