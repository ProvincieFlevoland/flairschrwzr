import { writable, get } from 'svelte/store';
import { storageFetch, getGeneration, isCurrentGeneration } from '$lib/apiClient.js';
import { NOTA_DB_KEY, storageKey } from '$lib/storageKeys.js';
import { addNotification } from '$lib/notificationStore.js';
import { storageGet, storageSet } from '$lib/safeStorage.js';
import { stashConflictCopy, removeConflictCopy, clearConflictCopies, pruneStoredConflictCopies } from '$lib/conflictCopy.js';

const DEFAULT_DB_DATA = {
    "users": [
        // MOCK AUTH: These users are for development only.
        // This will be connected to govchatnl in the future.
        { "id": "u2", "name": "Anna de Vries", "role": "auteur" },
        { "id": "u3", "name": "Mark Beheer", "role": "beheerder" },
        { "id": "u4", "name": "Admin", "role": "beheerder" },
        { "id": "u5", "name": "Communicatieadviseur", "role": "auteur" }
    ],
    "notas": [
        {
            "id": "n1",
            "title": "Verlenging Subsidie Energietransitie 2026",
            "status": "WIP",
            "lastModified": "2026-02-25T14:30:00.000Z",
            "configId": "conf-gs",
            "templateVersion": "GS-Nota Standaard v1.4",
            "authors": ["Anna de Vries"],
            "reviewers": [],
            "content": "<h2 class=\"dynamic-chapter\" data-chapter-id=\"c1\">Onderwerp kort en duidelijk weergeven</h2>\n<p>Verlenging subsidie energietransitie 2026</p>\n<h2 class=\"dynamic-chapter\" data-chapter-id=\"c2\">Beslispunten genummerd en in ‘TE + WERKWOORD’ vorm</h2>\n<p><span class=\"highlight-yellow dynamic-highlight\" data-sug-id=\"r3\">[Inleiding ontbreekt of bevat geen direct kernvoorstel. Voeg toe wat het college precies moet besluiten.]</span></p>\n<p><span class=\"highlight-red dynamic-highlight\" data-sug-id=\"r2\">Tevens willen wij u erop attenderen dat</span> de uitvoering van dit project ligt bij <span class=\"highlight-red dynamic-highlight\" data-sug-id=\"r1\">het ministerie van binnenlandse zaken</span>.</p>\n<h2 class=\"dynamic-chapter\" data-chapter-id=\"c5\">Argumenten</h2>\n<p><span class=\"highlight-yellow dynamic-highlight\" data-sug-id=\"r4\">Er wordt door het college voorgesteld om</span> de begroting aan te passen conform de nieuwe richtlijnen.</p>",
            "notes": []
        },
        {
            "id": "n2",
            "title": "Benoeming Bestuur Omgevingsdienst",
            "status": "Final-draft",
            "lastModified": "2026-02-24T09:15:00.000Z",
            "configId": "conf-gs",
            "templateVersion": "GS-Nota Standaard v1.4",
            "authors": ["Communicatieadviseur", "Anna de Vries"],
            "reviewers": [],
            "content": "<h2 class=\"dynamic-chapter\" data-chapter-id=\"c1\">Onderwerp kort en duidelijk weergeven</h2>\n<p>Het college wordt verzocht in te stemmen met de oprichting van het Infrastructuurfonds.</p>\n<h2 class=\"dynamic-chapter\" data-chapter-id=\"c5\">Argumenten</h2>\n<p>De provincie heeft een tekort op de begroting voor asfaltonderhoud.</p>",
            "notes": [
                {
                    "id": "note-1",
                    "reviewerName": "Communicatieadviseur",
                    "text": "Let op de financiële dekking in hoofdstuk 3. Is dit al afgestemd met control?",
                    "timestamp": "2026-02-24T10:15:00Z",
                    "resolved": false,
                    "type": "Vraag"
                }
            ]
        }
    ],
    "configurations": []
};

/** @type {any} */
const initialData = {
    notas: [],
    users: DEFAULT_DB_DATA.users,
    configurations: []
};

/** Global writable store: users, notas, configurations. Persisted via {@link saveDB}. */
export const dbStore = writable(initialData);

/**
 * Load persisted JSON from `localStorage` (`gs_nota_db:<userId>`, storageKeys.js) into {@link dbStore}, or seed defaults.
 * Strips legacy mock configs. Browser-only; no-op during SSR.
 */
export function initDB() {
    if (typeof window !== 'undefined') {
        const stored = storageGet(storageKey(NOTA_DB_KEY));
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                /** @type {any[]} */
                const configs = parsed.configurations || [];
                // Force clear mock configs if they still exist in local storage
                if (configs.some(c => c.id && c.id.startsWith('conf-mock-'))) {
                    parsed.configurations = [];
                }
                dbStore.set(parsed);
                console.log("DB loaded from localStorage");
                return;
            } catch (e) {
                console.error("Failed to parse db from localStorage", e);
            }
        }

        const seedData = { ...DEFAULT_DB_DATA, notas: [] };
        dbStore.set(seedData);
        storageSet(storageKey(NOTA_DB_KEY), JSON.stringify(seedData));
        console.log("DB initialized with default data");
    }
}

/** @type {ReturnType<typeof setTimeout> | null} Debounce timer for Azure nota sync. */
let _azureSyncTimer = null;

/** @type {Set<string>} Track nota IDs currently being synced to prevent race conditions with deletion */
const syncingNotaIds = new Set();

/**
 * `lastModified` each nota was loaded with from the backend, per nota id (see schrijfassistent/API.md, optimistic
 * concurrency). Sent as `X-Nota-Base-Modified` on `PUT /notas/{id}`; the backend answers 409 when
 * another client saved in between. A nota without a recorded base (created locally, never loaded)
 * is sent without the header, which the backend accepts as a first save.
 * @type {Map<string, string>}
 */
const notaBaseModified = new Map();

/** Shown when the backend answers 409. */
export const CONFLICT_MESSAGE = 'De nota is intussen door iemand anders opgeslagen. Laad de nota opnieuw om de laatste versie te zien.';

/**
 * A save that the backend refused because another client saved the nota after it was loaded (HTTP 409). Retrying cannot help (the base stays stale), so `autosaveStore` does not retry it.
 * `reported` is true when the conflict toast was shown for this very save (the first refusal), false when the save
 * was not even sent because the nota is still in conflict.
 */
export class NotaConflictError extends Error {
    /** @param {boolean} [reported] */
    constructor(reported = false) {
        super(CONFLICT_MESSAGE);
        this.name = 'NotaConflictError';
        this.status = 409;
        this.reported = reported;
    }
}

/**
 * Nota ids whose save was refused with 409 and that have not been reloaded since. While a nota is in
 * this set its saves are not sent: the backend would answer 409 again, and every autosave tick would repeat
 * the toast. The set is cleared per nota when the list is reloaded from the backend (`rememberNotaBase`), which is
 * also when the local copy is replaced by the stored one. It is a readable store so the header can show a steady
 * warning for as long as the state lasts.
 * @type {import('svelte/store').Writable<Set<string>>}
 */
export const conflictedNotas = writable(new Set());

/** @returns {boolean} true when a save of this nota was refused with 409 and the nota has not been reloaded since */
export function isNotaConflicted(id) {
    return get(conflictedNotas).has(id);
}

function markConflicted(id) {
    conflictedNotas.update((set) => new Set(set).add(id));
}

function clearConflicted(id) {
    conflictedNotas.update((set) => {
        if (!set.has(id)) return set;
        const next = new Set(set);
        next.delete(id);
        return next;
    });
}

/**
 * Saves whose outcome is unknown: the request was sent and no response came back (timeout, dropped connection, a
 * gateway answering 5xx). The backend may have stored the body anyway; if it did, the next save of the nota with the
 * old base gets a 409 that is caused by our own write. Each entry
 * holds the `lastModified` and the body of one such attempt, newest last, at most MAX_UNCONFIRMED per nota. Cleared on
 * the next confirmed save, on a real conflict and when the list is reloaded.
 * @type {Map<string, Array<{ sentLastModified: string | undefined, body: string }>>}
 */
const unconfirmedAttempts = new Map();
const MAX_UNCONFIRMED = 5;

function rememberUnconfirmed(id, sentLastModified, body) {
    const list = unconfirmedAttempts.get(id) || [];
    list.push({ sentLastModified, body });
    while (list.length > MAX_UNCONFIRMED) list.shift();
    unconfirmedAttempts.set(id, list);
}

/** JSON text with sorted keys, so two parses of the same nota compare equal whatever the key order. */
function canonicalJson(value) {
    return JSON.stringify(value, (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
            : v
    );
}

/**
 * Decides whether a 409 was caused by our own earlier write that never got its response: the stored `lastModified`
 * equals the one of an unconfirmed attempt, or (when the timestamp differs) the stored nota equals a body we sent.
 * @returns {Promise<boolean>}
 */
async function isOwnEarlierWrite(id, storedLastModified) {
    const attempts = unconfirmedAttempts.get(id);
    if (!attempts || !attempts.length) return false;
    if (typeof storedLastModified === 'string' && attempts.some((a) => a.sentLastModified === storedLastModified)) return true;
    try {
        const res = await storageFetch(`/notas/${encodeURIComponent(id)}`);
        if (!res.ok) return false;
        const stored = canonicalJson(await res.json());
        return attempts.some((a) => {
            try {
                return canonicalJson(JSON.parse(a.body)) === stored;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

/**
 * True when the nota has edits that the backend has not confirmed: it was never saved, or its `lastModified` moved on since
 * the base of the last load or save (Workspace advances it in place on every edit). Used by the close confirmation when
 * "Automatisch Opslaan" is off.
 * @returns {boolean}
 */
export function isNotaDirty(id) {
    const nota = get(dbStore).notas?.find((n) => n.id === id);
    if (!nota) return false;
    const base = notaBaseModified.get(id);
    return !base || nota.lastModified !== base;
}

/**
 * Records the server `lastModified` of notas that were just loaded from the backend. A nota that is loaded
 * again is no longer in conflict: the list replaces the local copy and the new base matches the stored version.
 * @param {Array<{ id: string, lastModified?: string }>} notas
 */
export function rememberNotaBase(notas) {
    for (const n of notas || []) {
        if (n && n.id && typeof n.lastModified === 'string' && n.lastModified) {
            notaBaseModified.set(n.id, n.lastModified);
            clearConflicted(n.id);
            unconfirmedAttempts.delete(n.id);
            // The list replaces the local text with the stored one: the refused copy has served its purpose.
            removeConflictCopy(n.id);
        }
    }
}

/** Forgets the recorded base of a nota (after a delete). */
export function forgetNotaBase(id) {
    notaBaseModified.delete(id);
    clearConflicted(id);
    unconfirmedAttempts.delete(id);
    removeConflictCopy(id);
}

/**
 * Forgets everything the previous session left in module state: bases, conflicts, unconfirmed attempts, queued saves,
 * the in-memory database and the conflict copies of the user. Called by `unmount()` and before a second `mount()`
 * so a remount for another user starts clean.
 */
export function resetStoreState() {
    notaBaseModified.clear();
    unconfirmedAttempts.clear();
    conflictedNotas.set(new Set());
    syncChains.clear();
    syncingNotaIds.clear();
    clearConflictCopies();
    dbStore.set({ notas: [], users: DEFAULT_DB_DATA.users, configurations: [] });
}

/** @returns {string | undefined} */
export function getNotaBase(id) {
    return notaBaseModified.get(id);
}

/**
 * Check if a nota is currently being synced.
 * @param {string} id - The nota ID to check
 * @returns {boolean}
 */
export function isNotaSyncing(id) {
    return syncingNotaIds.has(id);
}

/**
 * Wait for a nota sync to complete (with timeout).
 * @param {string} id - The nota ID to wait for
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<boolean>} True if sync completed, false if timed out
 */
export async function waitForNotaSync(id, timeoutMs = 2000) {
    if (!syncingNotaIds.has(id)) return true;

    const startTime = Date.now();
    while (syncingNotaIds.has(id)) {
        if (Date.now() - startTime > timeoutMs) {
            console.warn(`[Azure] Timeout waiting for sync of nota ${id}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return true;
}

/**
 * Per nota id, the tail of the chain of saves (saves of one nota run one after the other, so a
 * second save reads the base the first one advanced).
 * @type {Map<string, Promise<unknown>>}
 */
const syncChains = new Map();

/**
 * Uploads a specific nota to Azure Storage. Concurrent calls for the same nota are serialised: the second
 * call starts when the first has finished and then reads the nota and the conflict base afresh.
 * @param {string} id - The ID of the nota to sync.
 */
export function syncNotaToAzure(id) {
    // The nota counts as syncing from the moment the call is queued until the last queued save is done.
    syncingNotaIds.add(id);
    const previous = syncChains.get(id);
    // With no save in flight the new one starts at once (its body is captured in this tick); otherwise it
    // starts when the previous one has settled.
    const run = previous ? previous.then(() => performNotaSync(id), () => performNotaSync(id)) : performNotaSync(id);
    syncChains.set(id, run);
    const done = () => {
        if (syncChains.get(id) === run) {
            syncChains.delete(id);
            syncingNotaIds.delete(id);
        }
    };
    run.then(done, done);
    return run;
}

/**
 * One save of one nota; only called through {@link syncNotaToAzure}.
 * @param {string} id
 * @param {boolean} [adopted] true on the single resend after a 409 that was our own earlier write
 */
async function performNotaSync(id, adopted = false) {
    const db = get(dbStore);
    const nota = db.notas?.find(n => n.id === id);
    if (!nota) {
        console.warn(`[Azure] Sync aborted: Nota ${id} not found in store.`);
        return;
    }

    if (isNotaConflicted(id)) {
        // Refused before: the backend would answer 409 again. No request and no second toast: `reported` is false so a
        // caller that answers an explicit user action (manual save) can still say why nothing was saved.
        throw new NotaConflictError(false);
    }

    console.log(`[Azure] Syncing nota ${id}...`);
    // Capture what is sent before the first await: Workspace mutates `nota.lastModified` in place on every
    // keystroke, so the base for the next save must be the value that was in the body, not the live one.
    const body = JSON.stringify(nota);
    const sentLastModified = nota.lastModified;
    const gen = getGeneration();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const baseModified = notaBaseModified.get(id);
    const headers = { 'Content-Type': 'application/json' };
    if (baseModified) headers['X-Nota-Base-Modified'] = baseModified;
    let response;
    try {
        response = await storageFetch(`/notas/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers,
            body,
            signal: controller.signal
        });
    } catch (e) {
        // No response: the backend may or may not have stored the body. Remembered unless the session ended.
        if (isCurrentGeneration(gen)) rememberUnconfirmed(id, sentLastModified, body);
        if (isCurrentGeneration(gen)) console.error(`[Azure] Sync failed for ${id}:`, e && e.name);
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
    if (!isCurrentGeneration(gen)) throw new Error('Sessie beëindigd tijdens het opslaan');
    if (response.status === 409) {
        let storedLastModified;
        try {
            const detail = (await response.json())?.detail;
            storedLastModified = detail && typeof detail === 'object' ? detail.stored_last_modified : undefined;
        } catch {
            storedLastModified = undefined;
        }
        if (!adopted && (await isOwnEarlierWrite(id, storedLastModified)) && isCurrentGeneration(gen)) {
            // Our own earlier write that never got its response: adopt the stored version as base and send once more.
            if (typeof storedLastModified === 'string' && storedLastModified) notaBaseModified.set(id, storedLastModified);
            unconfirmedAttempts.delete(id);
            return performNotaSync(id, true);
        }
        if (!isCurrentGeneration(gen)) throw new Error('Sessie beëindigd tijdens het opslaan');
        // Another client saved this nota after we loaded it. One toast per conflict; the local
        // version stays in the editor and in the per-user cache; the retry loop of autosaveStore gives up at once.
        markConflicted(id);
        unconfirmedAttempts.delete(id);
        stashConflictCopy(id, body);
        addNotification(CONFLICT_MESSAGE, 'error', 8000);
        throw new NotaConflictError(true);
    }
    if (!response.ok) {
        // A gateway error may hide a write that did go through.
        if (response.status >= 500) rememberUnconfirmed(id, sentLastModified, body);
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        console.error(`[Azure] Sync failed for ${id}: HTTP ${response.status}`);
        throw err;
    }
    // The body that was sent is now the stored version; its lastModified is the next base.
    if (typeof sentLastModified === 'string' && sentLastModified) notaBaseModified.set(id, sentLastModified);
    unconfirmedAttempts.delete(id);
    console.log(`[Azure] Sync success for ${id}`);
    return true;
}

/**
 * Serializes the current {@link dbStore} snapshot to `localStorage` (`gs_nota_db:<userId>`).
 * Local persistence is still automatic. Remote sync is now manual.
 * Browser-only; no-op during SSR.
 */
export function saveDB() {
    if (typeof window !== 'undefined') {
        const currentData = get(dbStore);
        const key = storageKey(NOTA_DB_KEY);
        let json;
        try {
            json = JSON.stringify(currentData);
        } catch (e) {
            // a value that cannot be serialised (a cycle, or nesting deeper than the stack allows) must not escape as an uncaught
            // error from every later save; the cache of this session stays as it was and the autosave to the backend carries on.
            console.warn('[store] the local cache could not be serialised:', e instanceof Error ? e.name : typeof e);
            return;
        }
        // A full or blocked storage: drop the refused copies of conflicts once and try again; if it still
        // does not fit, one toast and the in-memory state carries on (the autosave still sends to the backend).
        if (!storageSet(key, json, { silent: true })) {
            pruneStoredConflictCopies();
            storageSet(key, json);
        }
        // _scheduleSyncNotasToAzure(); // DISABLED: Logic is now manual via syncNotaToAzure
    }
}

/**
 * Re-reads the serialized DB after another tab wrote `localStorage` (storage event).
 * Browser-only; no-op during SSR.
 */
export function reloadDbFromLocalStorage() {
    if (typeof window === 'undefined') return;
    const stored = storageGet(storageKey(NOTA_DB_KEY));
    if (!stored) return;
    try {
        dbStore.set(JSON.parse(stored));
    } catch (e) {
        console.error('reloadDbFromLocalStorage: parse failed', e);
    }
}

