/**
 * The bundle's only contact with the host page (container, theme hand-off and close sequence).
 *
 * - container element: the `.sa-root` element `mount()` received; components root their
 *   `querySelector` lookups here (through Svelte context) instead of `document`.
 * - dark mode: `document.documentElement.classList.contains('dark')` read on mount and observed with a
 *   MutationObserver on `<html>` limited to `attributeFilter: ['class']`. The CSS follows `.dark .sa-root`
 *   on its own; the store is for code that needs the value.
 * - close: `requestHostClose()` calls the `onClose` mount prop after the app finished its own close
 *   sequence (App.svelte `requestClose`). loader.js then calls `unmount()` and removes the container.
 * Nothing else of the host DOM is read or written.
 */
import { writable } from 'svelte/store';

/** @type {HTMLElement | null} */
let containerEl = null;
/** @type {(() => void | Promise<void>) | null} */
let onCloseCallback = null;
/** @type {MutationObserver | null} */
let darkObserver = null;

/** True while the host `<html>` carries the `dark` class. */
export const hostDarkMode = writable(false);

function readDarkClass() {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
}

/**
 * @param {{ container: HTMLElement, onClose?: () => void | Promise<void> }} options
 */
export function initHostBridge({ container, onClose }) {
    containerEl = container || null;
    onCloseCallback = typeof onClose === 'function' ? onClose : null;
    hostDarkMode.set(readDarkClass());
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        teardownDarkObserver();
        darkObserver = new MutationObserver(() => hostDarkMode.set(readDarkClass()));
        darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
}

function teardownDarkObserver() {
    if (darkObserver) {
        darkObserver.disconnect();
        darkObserver = null;
    }
}

export function teardownHostBridge() {
    teardownDarkObserver();
    containerEl = null;
    onCloseCallback = null;
}

/** The mounted container (`.sa-root`), or `document.body` before mount (dev page, tests). */
export function getContainer() {
    if (containerEl) return containerEl;
    return typeof document !== 'undefined' ? document.body : null;
}

/** Calls the host's `onClose`; the app has already saved and cleared its timers at this point. */
export async function requestHostClose() {
    if (onCloseCallback) await onCloseCallback();
}

/** Svelte context key under which App.svelte provides the container element. */
export const ROOT_EL_CONTEXT = 'schrijfassistent:rootEl';
