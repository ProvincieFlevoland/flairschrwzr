/**
 * Browser storage keys.
 *
 * The plain keys are `gs_nota_db`, `gs_ui_settings`, `gs_autosave_enabled` and
 * `govchat-suggestion-auto-advance`. In the overlay every key is suffixed with `:` and the Open WebUI
 * user id, so two users on a shared machine each see their own cache. The cache of a user starts empty.
 *
 * `setStorageUserId` is called by `mount()` before the stores read anything; the stores read their
 * persisted value through `reloadStores()` (see main.js) instead of at module evaluation time, because
 * the IIFE bundle is evaluated before the user is known.
 */

export const NOTA_DB_KEY = 'gs_nota_db';
export const UI_SETTINGS_KEY = 'gs_ui_settings';
export const AUTOSAVE_ENABLED_KEY = 'gs_autosave_enabled';
export const SUGGESTION_AUTO_ADVANCE_KEY = 'govchat-suggestion-auto-advance';
/** The local version of a nota whose save was refused with 409, kept as `gs_nota_conflict:<userId>:<notaId>` (store.js). */
export const NOTA_CONFLICT_KEY = 'gs_nota_conflict';

let userId = '';

/** @param {string | null | undefined} id - Open WebUI user id */
export function setStorageUserId(id) {
    userId = String(id ?? '').trim();
}

/** @returns {string} */
export function getStorageUserId() {
    return userId;
}

/**
 * The storage key for one base name and the current user.
 * SAFETY: the suffix is always added, also for an empty id, so an unidentified session never reads a
 * key that another origin or an earlier mount wrote under a different id.
 * @param {string} base
 */
export function storageKey(base) {
    return `${base}:${userId}`;
}
