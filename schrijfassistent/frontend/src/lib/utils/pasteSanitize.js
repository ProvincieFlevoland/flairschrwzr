/**
 * Clipboard → editor fragment: alleen tekst, <br>, <strong>, <em>.
 * Geen kleuren, fonts, span-styles of andere markup.
 */

const BLOCK_TAGS = new Set([
    'p',
    'div',
    'li',
    'ul',
    'ol',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'tr',
    'td',
    'th',
    'table',
    'tbody',
    'thead',
    'tfoot',
    'section',
    'article',
    'header',
    'footer',
    'main',
    'blockquote',
    'pre'
]);

/**
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function clipboardHtmlToMinimalFragment(html) {
    let root;
    if (typeof DOMParser !== 'undefined') {
        try {
            const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
            root = doc.body;
        } catch {
            root = null;
        }
    }
    if (!root) {
        const d = document.createElement('div');
        d.innerHTML = String(html || '');
        root = d;
    }

    const out = document.createDocumentFragment();

    /** Appends a `<br>` to the output fragment. */
    function appendBr() {
        out.appendChild(document.createElement('br'));
    }

    /** Appends plain text nodes, normalizing NBSP to space. */
    function appendText(str) {
        const t = String(str).replace(/\u00a0/g, ' ');
        if (t === '') return;
        out.appendChild(document.createTextNode(t));
    }

    /**
     * Walks inline nodes into `container`, preserving only strong/em/br and text.
     * @param {Node} node
     * @param {DocumentFragment|HTMLElement} container
     */
    function fillInline(node, container) {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = (node.textContent || '').replace(/\u00a0/g, ' ');
            if (t) container.appendChild(document.createTextNode(t));
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.nodeName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') return;
        if (tag === 'br') {
            container.appendChild(document.createElement('br'));
            return;
        }
        if (tag === 'strong' || tag === 'b') {
            const s = document.createElement('strong');
            for (const c of Array.from(node.childNodes)) fillInline(c, s);
            if (s.childNodes.length) container.appendChild(s);
            return;
        }
        if (tag === 'em' || tag === 'i') {
            const s = document.createElement('em');
            for (const c of Array.from(node.childNodes)) fillInline(c, s);
            if (s.childNodes.length) container.appendChild(s);
            return;
        }
        for (const c of Array.from(node.childNodes)) fillInline(c, container);
    }

    /**
     * Depth-first visit: block tags become paragraph breaks; allowed inline tags only.
     * @param {Node} node
     */
    function visit(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            appendText(node.textContent || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.nodeName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') return;

        if (tag === 'br') {
            appendBr();
            return;
        }

        if (BLOCK_TAGS.has(tag)) {
            if (out.childNodes.length > 0) appendBr();
            for (const c of Array.from(node.childNodes)) visit(c);
            appendBr();
            return;
        }

        if (tag === 'strong' || tag === 'b') {
            const s = document.createElement('strong');
            for (const c of Array.from(node.childNodes)) fillInline(c, s);
            if (s.childNodes.length) out.appendChild(s);
            return;
        }

        if (tag === 'em' || tag === 'i') {
            const s = document.createElement('em');
            for (const c of Array.from(node.childNodes)) fillInline(c, s);
            if (s.childNodes.length) out.appendChild(s);
            return;
        }

        for (const c of Array.from(node.childNodes)) visit(c);
    }

    for (const c of Array.from(root.childNodes)) visit(c);

    return out;
}

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function plainTextToFragment(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(line));
    });
    return frag;
}

/**
 * @param {string} html
 * @param {string} plain
 * @returns {DocumentFragment}
 */
export function clipboardToMinimalFragment(html, plain) {
    const htmlStr = String(html || '').trim();
    const plainStr = String(plain || '').replace(/\r\n/g, '\n');

    if (htmlStr) {
        const frag = clipboardHtmlToMinimalFragment(html);
        if (frag.childNodes.length > 0) return frag;
    }

    return plainTextToFragment(plainStr);
}
