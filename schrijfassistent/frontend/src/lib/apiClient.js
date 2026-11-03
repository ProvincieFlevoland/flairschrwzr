/**
 * The one HTTP module of the bundle.
 * The base URL comes from `config.js` (`config.api_base_url`) and every call carries `Authorization: Bearer <token>` from the
 * `getToken` mount prop, which re-reads `localStorage.token` on every call so a refreshed Open WebUI
 * session keeps working. The token is kept nowhere else.
 *
 * Components call `storageFetch(path, init)` (path relative to `/api/v1/storage`) or `apiFetch(path, init)`
 * (path relative to the backend root). Both are plain `fetch` wrappers: callers keep their own `res.ok`
 * handling.
 */
import { apiBaseUrl, IS_DEV } from './config.js';

export const API_V1_STR = '/api/v1';

/** @type {(() => string | null | undefined) | null} */
let tokenProvider = null;

/**
 * Session teardown. Every request of a mount carries the signal of
 * `sessionController`; `abortAllRequests()` (called by `unmount()` and by a second `mount()`) aborts what is in
 * flight and bumps `generation`. Continuations that run after an await compare the generation they started with
 * (`isCurrentGeneration`) and drop their result, so an answer that was already on its way cannot be written into the
 * next user's session and nothing sends a request with the next user's token on behalf of the previous one.
 */
let generation = 0;
let sessionController = new AbortController();

/** @returns {number} */
export function getGeneration() {
    return generation;
}

/** @param {number} g */
export function isCurrentGeneration(g) {
    return g === generation;
}

/** Aborts every request in flight and invalidates the answers that are still on their way. */
export function abortAllRequests() {
    generation += 1;
    const c = sessionController;
    sessionController = new AbortController();
    try {
        c.abort();
    } catch {
        /* nothing to abort */
    }
}

/** @param {AbortSignal | null | undefined} own @param {AbortSignal} session */
function combineSignals(own, session) {
    if (!own) return session;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([own, session]);
    const c = new AbortController();
    const abort = () => c.abort();
    if (own.aborted || session.aborted) c.abort();
    else {
        own.addEventListener('abort', abort, { once: true });
        session.addEventListener('abort', abort, { once: true });
    }
    return c.signal;
}

/** Set by `mount()` from the `getToken` prop. */
export function setTokenProvider(fn) {
    tokenProvider = typeof fn === 'function' ? fn : null;
}

/** @returns {string} the current Open WebUI token, or '' */
export function currentToken() {
    try {
        return tokenProvider ? String(tokenProvider() || '') : '';
    } catch {
        return '';
    }
}

/** Absolute URL of a backend path (`/api/v1/...`). */
export function apiUrl(path) {
    return `${apiBaseUrl()}${path}`;
}

/** Absolute URL of a storage path (relative to `/api/v1/storage`). */
export function storageUrl(path) {
    return apiUrl(`${API_V1_STR}/storage${path}`);
}

/**
 * `fetch` with the bearer token added. `init.headers` may be a plain object; the Authorization
 * header is only added when a token is available.
 * @param {string} path - path relative to the backend root, e.g. `/api/v1/storage/notas`
 * @param {RequestInit} [init]
 */
export function apiFetch(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    const token = currentToken();
    if (token && !('Authorization' in headers)) headers.Authorization = `Bearer ${token}`;
    // `credentials: 'omit'`: the backend authenticates with the bearer only; the host's own session cookie must not
    // travel along on a same-origin deployment.
    return fetch(apiUrl(path), { ...init, headers, credentials: 'omit', signal: combineSignals(init.signal, sessionController.signal) });
}

/**
 * `fetch` on the storage router with the bearer token added.
 * @param {string} path - relative to `/api/v1/storage`, e.g. `/notas`
 * @param {RequestInit} [init]
 */
export function storageFetch(path, init = {}) {
    return apiFetch(`${API_V1_STR}/storage${path}`, init);
}

/**
 * Shown when fetch() fails entirely (connection refused, DNS, offline, CORS misconfig).
 * In a dev build, appends the configured API base URL to speed up debugging (api.ts:30-39).
 */
export function describeApiUnreachableError() {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    let msg =
        'Netwerkfout: de schrijfassistent-backend is niet bereikbaar. Probeer het later opnieuw.';
    if (offline) msg += ' Je lijkt offline te zijn.';
    if (IS_DEV) msg += ` Verwachte API-basis: ${apiBaseUrl()}`;
    return msg;
}
