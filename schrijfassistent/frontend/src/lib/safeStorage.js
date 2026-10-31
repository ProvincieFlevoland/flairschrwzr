/**
 * Every `localStorage` access of the bundle goes through this module.
 * Reading and writing never throw: a blocked, absent or full storage (private window, quota, disabled site data,
 * a host that shares a nearly full 5 MB origin) degrades the per-user cache and nothing else. The state stays in
 * memory, the autosave keeps sending to the backend, and one toast per mount tells the auteur that the cache is not
 * being kept. The storage key itself is built by the caller (`storageKey()`, storageKeys.js).
 */
import { addNotification } from './notificationStore.js';

export const STORAGE_FULL_MESSAGE =
    'De lokale cache is vol of niet beschikbaar. Wijzigingen worden alleen op de server bewaard.';

let warned = false;

/** Called by `mount()` so a second session in the same page shows the warning again. */
export function resetStorageWarning() {
    warned = false;
}

/** @returns {Storage | null} */
function ls() {
    try {
        if (typeof window === 'undefined') return null;
        const s = window.localStorage;
        return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
    } catch {
        return null;
    }
}

/** @param {string} key @returns {string | null} */
export function storageGet(key) {
    try {
        const s = ls();
        return s ? s.getItem(key) : null;
    } catch {
        return null;
    }
}

/**
 * Writes a value; returns false when it could not be stored. The first failure of a mount shows one toast unless `silent`.
 * @param {string} key @param {string} value @param {{ silent?: boolean }} [opts]
 * @returns {boolean}
 */
export function storageSet(key, value, opts = {}) {
    try {
        const s = ls();
        if (!s) throw new Error('localStorage unavailable');
        s.setItem(key, value);
        return true;
    } catch {
        if (!opts.silent && !warned) {
            warned = true;
            // The message carries no key or value (no nota content in the toast or the console).
            addNotification(STORAGE_FULL_MESSAGE, 'warning', 8000);
        }
        return false;
    }
}

/** @param {string} key */
export function storageRemove(key) {
    try {
        const s = ls();
        if (s) s.removeItem(key);
    } catch {
        /* nothing to remove */
    }
}

/** @param {string} prefix @returns {string[]} the keys that start with the prefix */
export function storageKeysWithPrefix(prefix) {
    const out = [];
    try {
        const s = ls();
        if (!s) return out;
        for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k && k.startsWith(prefix)) out.push(k);
        }
    } catch {
        /* ignore */
    }
    return out;
}
