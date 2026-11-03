/**
 * Runtime configuration of the bundle.
 *
 * The configuration arrives as the `config` prop of `mount()` and nowhere else (`{ api_base_url,
 * asset_base_url, b1_metrics_doc_url }`); no `window` global is read.
 * `import.meta.env` is banned in shipped code; `DEV` is the build-time constant `__BUILD_DEV__`.
 */

import { safeLinkUrl } from './utils/safeUrl.js';

/** @typedef {{ api_base_url?: string, asset_base_url?: string, b1_metrics_doc_url?: string }} RuntimeConfig */

/** Defaults; loader.js applies the same ones. */
export const DEFAULT_API_BASE_URL = '/apps/schrijfassistent';
export const DEFAULT_ASSET_BASE_URL = '/static/apps/schrijfassistent';

/** @type {RuntimeConfig | null} */
let runtimeConfig = null;

/** Set by `mount()` from the `config` prop. */
export function setRuntimeConfig(config) {
    runtimeConfig = config && typeof config === 'object' ? { ...config } : null;
}

/** @returns {RuntimeConfig} */
export function getRuntimeConfig() {
    return runtimeConfig || {};
}

/** Backend origin or path, without trailing slash; the design default applies when the prop is absent. */
export function apiBaseUrl() {
    const raw = String(getRuntimeConfig().api_base_url ?? '').trim();
    return (raw || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

/** Base path of the published static assets (logo); default when absent. */
export function assetBaseUrl() {
    const raw = String(getRuntimeConfig().asset_base_url ?? '').trim();
    return (raw || DEFAULT_ASSET_BASE_URL).replace(/\/+$/, '');
}

/**
 * Documentation link of the Direct Duidelijk metrics panel; empty hides the link as today.
 * Same policy as every other link: `safeLinkUrl`, so only `https:` and `mailto:` pass. The loader
 * (`loader.js`) still accepts `http:` and path values from `apps.json`; the bundle drops them.
 */
export function b1MetricsDocUrl() {
    return safeLinkUrl(String(getRuntimeConfig().b1_metrics_doc_url ?? ''));
}

/** Build-time constants injected by the Vite `define` (vite.config.ts). */
export const BUILD_HASH = typeof __BUILD_HASH__ === 'string' ? __BUILD_HASH__ : 'dev';
export const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';
export const IS_DEV = typeof __BUILD_DEV__ === 'boolean' ? __BUILD_DEV__ : false;
