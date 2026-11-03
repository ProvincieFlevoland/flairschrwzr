/**
 * Role mapping from the Open WebUI identity to the app's roles.
 *
 * Open WebUI `role === 'admin'` maps to `beheerder`; every other role maps to `auteur`. The `reviewer`
 * role is not granted by any mechanism and stays unreachable.
 * `authors[]` and `reviewers[]` stay display-only name lists and receive the Open WebUI display name.
 */

/**
 * @typedef {{ id?: string, email?: string, name?: string, role?: string }} OpenWebUIUser
 * @typedef {{ id: string, email: string, name: string, role: 'beheerder' | 'auteur' }} AppUser
 */

/**
 * @param {OpenWebUIUser | null | undefined} user
 * @returns {AppUser}
 */
export function mapOpenWebUIUser(user) {
    const u = user || {};
    const role = String(u.role ?? '').trim().toLowerCase() === 'admin' ? 'beheerder' : 'auteur';
    return {
        id: String(u.id ?? ''),
        email: String(u.email ?? ''),
        name: String(u.name ?? '').trim() || String(u.email ?? '').trim() || 'Onbekende gebruiker',
        role,
    };
}

/**
 * `mount()` refuses to run without an identity (the loader opens nothing without one, so a
 * missing user here means a loader regression). Without an id every unidentified session would share the storage
 * key `<base>:` and the backend could not attribute anything.
 * @param {OpenWebUIUser | null | undefined} user
 * @returns {AppUser}
 */
export function requireOpenWebUIUser(user) {
    if (!user || typeof user !== 'object' || !String(user.id ?? '').trim()) {
        throw new Error('SchrijfassistentApp.mount: props.user with an id is required (Open WebUI identity)');
    }
    return mapOpenWebUIUser(user);
}

/**
 * The view an identity may see: the configurator (`admin`) is for the mapped role `beheerder` only.
 * One pure function so App.svelte and the unit tests decide the same way.
 * @param {string} view - 'dashboard' | 'editor' | 'admin'
 * @param {{ role?: string } | null | undefined} user
 * @returns {string}
 */
export function viewForRole(view, user) {
    return view === 'admin' && !(user && user.role === 'beheerder') ? 'dashboard' : view;
}

/**
 * The view after sign-in and after leaving the editor: the nota overview for everyone. A beheerder opens the
 * configurator from the header ("Beheerdersweergave") and returns with "Als auteur werken".
 * @param {{ role?: string } | null | undefined} _user
 * @param {boolean} [_actingAsAuthor]
 * @returns {'dashboard'}
 */
export function homeViewFor(_user, _actingAsAuthor = false) {
    return 'dashboard';
}

/**
 * Whether the identity starts the app acting as auteur: a beheerder does, so the overview it lands on is a working one
 * (new nota, edit) and not the read-only list a beheerder sees; "Beheerdersweergave" in the header switches back.
 * @param {{ role?: string } | null | undefined} user
 * @returns {boolean}
 */
export function startsAsAuthor(user) {
    return !!user && user.role === 'beheerder';
}
