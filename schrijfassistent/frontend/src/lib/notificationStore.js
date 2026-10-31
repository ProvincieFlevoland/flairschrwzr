import { writable } from 'svelte/store';

/**
 * @typedef {Object} ToastNotification
 * @property {string} id
 * @property {string} message
 * @property {'success' | 'error' | 'info' | 'warning'} type
 * @property {number} timestamp
 */

/** @type {import('svelte/store').Writable<ToastNotification[]>} */
export const notifications = writable([]);

/**
 * Adds a new toast notification and removes it after a timeout.
 * @param {string} message - The text to display.
 * @param {'success' | 'error' | 'info' | 'warning'} type - The variant of the toast.
 * @param {number} durationMs - How long it stays visible (default 4000).
 */
export function addNotification(message, type = 'success', durationMs = 4000) {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast = { id, message, type, timestamp: Date.now() };

    notifications.update((all) => [...all, newToast]);

    if (durationMs > 0) {
        setTimeout(() => {
            notifications.update((all) => all.filter((t) => t.id !== id));
        }, durationMs);
    }
}

/**
 * Manual removal of a specific toast.
 * @param {string} id
 */
export function dismissNotification(id) {
    notifications.update((all) => all.filter((t) => t.id !== id));
}
