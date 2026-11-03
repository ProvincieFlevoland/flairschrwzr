/**
 * Decodes common NBSP HTML entities and normalises Unicode NBSP to a regular space.
 * Agent JSON sometimes contains literal `&nbsp;` strings; block HTML may too before tag strip.
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function decodeHtmlSpaceEntities(str) {
    if (str == null || str === '') return '';
    return String(str)
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#0*160;/gi, ' ')
        .replace(/&#x0*A0;/gi, ' ')
        .replace(/\u00a0/g, ' ');
}

/**
 * Plain text from block HTML for taalreview / highlight lookup.
 * Preserves formatting: newlines, tabs, multiple spaces.
 * Only removes HTML tags and normalizes non-breaking spaces.
 * @param {string} html
 * @returns {string}
 */
export function stripBlockPlain(html) {
    return decodeHtmlSpaceEntities(html || '')
        .replace(/<[^>]*>/g, ' ')  // HTML tags → space (prevents word collision)
        .replace(/[\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')  // Exotic unicode spaces → regular space
        .trim();
}

/**
 * Plain text for taalreview requests: tags → space, nbsp → space.
 * Preserves formatting: newlines, tabs, multiple spaces.
 * Only removes HTML tags and normalizes non-breaking spaces.
 * @param {string} html
 * @returns {string}
 */
export function stripBlockPlainForTaalreview(html) {
    return decodeHtmlSpaceEntities(html || '')
        .replace(/<[^>]*>/g, ' ')  // HTML tags → space (prevents word collision)
        // Andere breed-/smalle spaties (o.a. na plakken uit Word/PDF) → gewone spatie
        .replace(/[\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
        .trim();
}
