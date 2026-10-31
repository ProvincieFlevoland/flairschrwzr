/**
 * The local copy of a nota whose save was refused with 409.
 *
 * Lifecycle. `stashConflictCopy` keeps the refused body in memory and, when it fits, under `gs_nota_conflict:<userId>:<notaId>`
 * (at most MAX_COPIES per user and MAX_BYTES each; the oldest copy is dropped first). The copy is removed when that nota is
 * loaded again from the backend, when the user closes the app, and when another user mounts. "Kopieer mijn versie" puts
 * the plain text of the refused version on the clipboard. Nothing in this module logs nota text or titles.
 */
import { NOTA_CONFLICT_KEY, storageKey } from './storageKeys.js';
import { storageGet, storageSet, storageRemove, storageKeysWithPrefix } from './safeStorage.js';

export const MAX_COPIES = 5;
export const MAX_BYTES = 1_000_000;

/** @type {Map<string, string>} insertion order = age */
const memory = new Map();

const prefix = () => `${storageKey(NOTA_CONFLICT_KEY)}:`;
export const conflictCopyKey = (id) => `${prefix()}${id}`;

/** @param {string} id @param {string} body */
export function stashConflictCopy(id, body) {
    memory.delete(id);
    memory.set(id, body);
    while (memory.size > MAX_COPIES) {
        const oldest = memory.keys().next().value;
        removeConflictCopy(oldest);
    }
    if (body.length <= MAX_BYTES) storageSet(conflictCopyKey(id), body, { silent: true });
    // Copies of an earlier page load that the memory map does not know: keep the total within the cap.
    const stored = storageKeysWithPrefix(prefix());
    if (stored.length > MAX_COPIES) {
        for (const k of stored) {
            const sid = k.slice(prefix().length);
            if (!memory.has(sid)) storageRemove(k);
        }
    }
}

/** @param {string} id @returns {string | null} */
export function getConflictCopy(id) {
    return memory.get(id) ?? storageGet(conflictCopyKey(id));
}

/** @param {string} id */
export function removeConflictCopy(id) {
    memory.delete(id);
    storageRemove(conflictCopyKey(id));
}

/** Frees storage space: drops the stored copies but keeps the in-memory ones (quota pressure). */
export function pruneStoredConflictCopies() {
    for (const k of storageKeysWithPrefix(prefix())) storageRemove(k);
}

/** Removes every copy of the current user (close, logout, user switch). */
export function clearConflictCopies() {
    for (const k of storageKeysWithPrefix(prefix())) storageRemove(k);
    memory.clear();
}

/**
 * The plain text of a nota body: the title, then every block of the content on its own paragraph. The HTML is parsed
 * inertly (DOMParser: no script runs, nothing is attached to the page) and only `textContent` is read.
 * @param {string} body the nota JSON that was refused
 * @returns {string}
 */
export function conflictCopyPlainText(body) {
    let nota;
    try {
        nota = JSON.parse(body);
    } catch {
        return '';
    }
    if (!nota || typeof nota !== 'object') return '';
    const parts = [];
    if (typeof nota.title === 'string' && nota.title.trim()) parts.push(nota.title.trim());
    const html = typeof nota.content === 'string' ? nota.content : '';
    if (html && typeof DOMParser !== 'undefined') {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // childNodes, not children: a cell body can hold bare text nodes next to the block elements.
        for (const node of Array.from(doc.body.childNodes)) {
            const t = (node.textContent || '').replace(/\u00a0/g, ' ').trim();
            if (t) parts.push(t);
        }
    }
    return parts.join('\n\n');
}

/**
 * Puts the plain text of the refused version of a nota on the clipboard.
 * @param {string} id
 * @returns {Promise<boolean>} true when something was copied
 */
export async function copyConflictCopy(id) {
    const body = getConflictCopy(id);
    const text = body ? conflictCopyPlainText(body) : '';
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
