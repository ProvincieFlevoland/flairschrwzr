/**
 * Svelte action for a dialog or menu that opens over the app (`use:dialogFocus={{ onClose }}`).
 *
 * - Focus moves into it when it opens: the first control, else the element itself (which gets `tabindex="-1"`), unless
 *   something inside already has the focus (an `autofocus` input).
 * - Tab and Shift+Tab stay inside it.
 * - A plain Escape closes it through `onClose`. It is caught on `window` in the capture phase and stops there, so the
 *   suggestion modal's and the Workspace's Escape listeners do not act on the same key; a chord with a modifier is
 *   left alone (main.js stopHostShortcuts owns Shift+Esc).
 * - When it closes, focus returns to the element that had it before, if that element is still in the page.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {HTMLElement} node
 * @param {{ onClose?: () => void }} [params]
 */
export function dialogFocus(node, params = {}) {
    let onClose = params.onClose;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el instanceof HTMLElement && el.getClientRects().length > 0);

    /**
     * Initial focus: an `autofocus` control first (Svelte inserts the dialog after page load, so the attribute alone
     * focuses nothing), else the first control that is not the close button, else the first control, else the element.
     */
    function focusFirst() {
        if (node.contains(document.activeElement)) return;
        const all = focusables();
        const marked = all.find((el) => el.hasAttribute('autofocus') || el.hasAttribute('data-autofocus'));
        const first = marked || all.find((el) => el.getAttribute('aria-label') !== 'Sluiten') || all[0];
        (first || node).focus({ preventScroll: true });
    }

    /** @param {KeyboardEvent} e */
    function onWindowKeydown(e) {
        if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (!document.contains(node)) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof onClose === 'function') onClose();
    }

    /** @param {KeyboardEvent} e */
    function onNodeKeydown(e) {
        if (e.key !== 'Tab') return;
        const f = focusables();
        if (!f.length) { e.preventDefault(); node.focus(); return; }
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && node.contains(active);
        if (e.shiftKey) {
            if (!inside || active === first || active === node) { e.preventDefault(); last.focus(); }
        } else if (!inside || active === last) {
            e.preventDefault();
            first.focus();
        }
    }

    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    window.addEventListener('keydown', onWindowKeydown, true);
    node.addEventListener('keydown', onNodeKeydown);
    const timer = setTimeout(focusFirst, 0);

    return {
        update(next = {}) { onClose = next.onClose; },
        destroy() {
            clearTimeout(timer);
            window.removeEventListener('keydown', onWindowKeydown, true);
            node.removeEventListener('keydown', onNodeKeydown);
            if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
        },
    };
}
