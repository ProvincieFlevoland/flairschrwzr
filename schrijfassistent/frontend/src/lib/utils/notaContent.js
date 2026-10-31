// The safety filter for nota HTML lives in safetyFilter.js; re-exported here,
// next to the other nota content helpers, so `utils/notaContent.js` stays the one import for "nota HTML".
export { sanitizeNotaHtml, sanitizeNotaList } from './safetyFilter.js';

/**
 * Parses nota HTML into chapter blocks (plain text per h2.dynamic-chapter).
 * Works in browser and Node (tests) without DOMParser.
 * @param {string|null|undefined} htmlContent
 * @returns {Array<{ title: string, content: string }>}
 */
export function extractChaptersFromHtml(htmlContent) {
    if (!htmlContent) return [];

    if (typeof document !== 'undefined' && typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlContent, 'text/html');
        const chapters = [];
        let currentTitle = '';
        let currentNodes = [];

        doc.body.childNodes.forEach((node) => {
            if (node.nodeType === 1 && node.tagName === 'H2') {
                if (currentTitle || currentNodes.length) {
                    chapters.push({
                        title: currentTitle,
                        content: currentNodes.map((n) => n.textContent).join(' ').trim()
                    });
                }
                currentTitle = node.textContent.trim();
                currentNodes = [];
            } else {
                currentNodes.push(node);
            }
        });
        if (currentTitle || currentNodes.length) {
            chapters.push({
                title: currentTitle,
                content: currentNodes.map((n) => n.textContent).join(' ').trim()
            });
        }
        return chapters.filter((c) => c.title || c.content);
    }

    const chapters = [];
    const parts = htmlContent.split(/<h2\b[^>]*>/i);
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const closeIdx = part.search(/<\/h2>/i);
        if (closeIdx === -1) continue;
        const title = part.slice(0, closeIdx).replace(/<[^>]*>/g, '').trim();
        const body = part.slice(closeIdx + 5).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        chapters.push({ title, content: body });
    }
    return chapters.filter((c) => c.title || c.content);
}
