// Loads the three B1 lexicons on first use of the Direct Duidelijk tab. The files are published next to the bundle
// (`<asset_base_url>/lexicons/b1-lexicon-<kind>.<hash>.json`, emitted by vite.config.ts with a content hash in the name) and
// are fetched once; a failed load is retried on the next call.
import { assetBaseUrl } from '../config.js';
import { setB1Lexicons, b1LexiconsLoaded } from './analysis.js';

/** @type {Promise<void> | null} */
let pending = null;

/** Names of the lexicon files, injected by vite.config.ts (`__B1_LEXICON_FILES__`); empty in node tests. */
function lexiconFiles() {
    return typeof __B1_LEXICON_FILES__ === 'object' && __B1_LEXICON_FILES__ ? __B1_LEXICON_FILES__ : null;
}

/**
 * Resolves when the lexicons are installed in `analysis.js`; rejects when they cannot be fetched.
 * @param {{ fetchJson?: (kind: 'jargon' | 'formal' | 'cohesion') => Promise<string[]> }} [options] - a loader for tests
 * @returns {Promise<void>}
 */
export function ensureB1Lexicons({ fetchJson } = {}) {
    if (b1LexiconsLoaded()) return Promise.resolve();
    if (pending) return pending;
    const files = lexiconFiles();
    const load = fetchJson || (async (kind) => {
        if (!files || !files[kind]) throw new Error('B1 lexicon file names are not known');
        const response = await fetch(`${assetBaseUrl()}/${files[kind]}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`B1 lexicon ${kind}: HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error(`B1 lexicon ${kind}: not a list`);
        return data;
    });
    pending = Promise.all([load('jargon'), load('formal'), load('cohesion')])
        .then(([jargon, formal, cohesion]) => { setB1Lexicons({ jargon, formal, cohesion }); })
        .finally(() => { pending = null; });
    return pending;
}
