/**
 * The pure parts of the close sequence, kept out of App.svelte so the unit tests can
 * cover them (tests/close-sequence.test.mjs): when the confirmation is asked, and the order of the steps.
 */

/**
 * Which confirmation the close button asks for, '' for none. A nota whose saving is suspended by a 409 (`conflicted`,
 *) asks first because closing discards the only copy of the auteur's latest text; a pending or in-flight save asks too;
 * with "Automatisch Opslaan" off an edited nota (`dirtyUnsaved`) asks whether to save first.
 * @param {string} status the autosave status
 * @param {{ conflicted?: boolean, dirtyUnsaved?: boolean }} [extra]
 * @returns {'' | 'conflict' | 'saving' | 'pending' | 'unsaved'}
 */
export function closeConfirmationKind(status, extra = {}) {
    if (extra.conflicted) return 'conflict';
    if (status === 'saving') return 'saving';
    if (status === 'pending') return 'pending';
    if (extra.dirtyUnsaved) return 'unsaved';
    return '';
}

/** A pending or in-flight save, a suspended save or unsaved edits ask for confirmation before the app closes. */
export function needsCloseConfirmation(status, extra = {}) {
    return closeConfirmationKind(status, extra) !== '';
}

/**
 * Runs the close steps in this order: first the auto-AI countdowns and the auto-title
 * timer are cleared (`beforeSave`), then the immediate autosave runs with its own timeout and retries, then
 * the remaining state is reset (`reset`: the autosave store), then the host is told to unmount. Clearing the timers
 * first closes the window in which a countdown fires during a slow or retried PUT (up to the timeout) and starts
 * an agent call or a title call for an app that is closing.
 * A failing save or a failing `onClose` is logged and never stops the close: the user pressed the close button and
 * must leave.
 * @param {{ beforeSave?: () => void, autosave: () => Promise<unknown>, reset: () => void, afterSave?: () => void, onClose?: (() => unknown) | null }} steps
 */
export async function runCloseSequence({ beforeSave, autosave, reset, afterSave, onClose }) {
    if (beforeSave) {
        try {
            beforeSave();
        } catch (e) {
            console.error('[Schrijfassistent] clearing the timers before the save failed:', e);
        }
    }
    try {
        await autosave();
    } catch (e) {
        console.error('[Schrijfassistent] autosave on close failed:', e);
    }
    reset();
    if (afterSave) afterSave();
    if (typeof onClose === 'function') {
        try {
            await onClose();
        } catch (e) {
            console.error('[Schrijfassistent] onClose failed:', e);
        }
    }
}

/**
 * What leaving the editor for the overview ("Terug naar Overzicht", the logo) does with the active nota.
 * The dashboard replaces the nota list with the stored versions when it mounts, so an edit that is still waiting for
 * the autosave debounce would be lost: it is saved first (`save`). With "Automatisch Opslaan" off the auteur is
 * asked (`ask`). A conflicted nota cannot be sent, and reloading the list is its documented recovery (`leave`).
 * @param {string} status the autosave status (`pending`: an edit is waiting for the debounce; `saving`: a PUT is in flight)
 * @param {{ conflicted?: boolean, autosaveOn?: boolean, dirty?: boolean }} [extra] `dirty`: store.js `isNotaDirty`
 * @returns {'leave' | 'save' | 'ask'}
 */
export function leaveEditorAction(status, extra = {}) {
    if (extra.conflicted) return 'leave';
    const unsaved = !!extra.dirty || status === 'pending' || status === 'saving';
    if (!unsaved) return 'leave';
    return extra.autosaveOn === false ? 'ask' : 'save';
}
