/**
 * Scheme check for links that come from configuration or from AI answers An admin-configured reference link (`b1Guidelines` sources, suggestion `referenceLinks`) is rendered as a
 * clickable anchor inside the Open WebUI origin, so `javascript:`, `data:`, `vbscript:` and every other scheme must
 * not become a link. Only `https:` and `mailto:` pass; a path or an `http:` URL does
 * not, because a reference link has no reason to be relative or unencrypted.
 *
 * SAFETY: the value is parsed with the URL parser and the protocol of the parsed result decides, so `JaVaScRiPt:`,
 * a leading space, a tab or newline inside the scheme and a `//host` network-path reference are judged by what the
 * browser would make of them. The returned string is the parser's `href`, never the raw input.
 */

/** @param {unknown} value @returns {string} the normalised URL when its scheme is https or mailto, else '' */
export function safeLinkUrl(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw || raw.length > 2048) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return '';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return '';
    // Credentials in the URL (`https://user:pass@host`) are refused.
    if (parsed.username || parsed.password) return '';
    return parsed.href;
}
