<script>
    /**
     * Root component of the bundle. It holds the root logic: `currentView`,
     * `actingAsAuthor`, configuration loading, `createNewNota`, nota switch and the immediate autosave
     * on every view change. The password gate and the mock login are replaced by the `user` prop
     * that `mount()` receives from loader.js. `app.css` is imported once here (`+layout.svelte`),
     * and the two singletons `SuggestionModal` and `ToastContainer` are mounted inside `.sa-root`.
     *
     * The editor view is the Workspace (`bind:this={workspaceRef}`); the beheerder view
     * is the configurator (AdminDashboard), reachable only for the mapped role `beheerder` (Open WebUI admin).
     */
    import { onMount, onDestroy, setContext } from 'svelte';
    import { viewForRole, homeViewFor, startsAsAuthor } from '$lib/identityAdapter.js';
    import { get } from 'svelte/store';
    import './styles/app.css';
    import './styles/dark.css'; // the twins win by one extra class (`.dark`), not by source order: component styles come after this file
    import { initDB, dbStore, saveDB, syncNotaToAzure, conflictedNotas, isNotaDirty } from '$lib/store.js';
    import { copyConflictCopy } from '$lib/conflictCopy.js';
    import { triggerImmediateAutoSave, resetAutoSaveState, autoSaveStatus, isAutoSaveEnabled, setAutosaveTornDown } from '$lib/autosaveStore.js';
    import { closeConfirmationKind, runCloseSequence, leaveEditorAction } from '$lib/closeSequence.js';
    import { addNotification } from '$lib/notificationStore.js';
    import { activeSuggestion } from '$lib/suggestionStore.js';
    import { storageFetch } from '$lib/apiClient.js';
    import { ROOT_EL_CONTEXT } from '$lib/hostBridge.js';
    import { naturalSort } from '$lib/utils/sorting.js';
    import Header from '$lib/components/Header.svelte';
    import NotaDashboard from '$lib/components/NotaDashboard.svelte';
    import SuggestionModal from '$lib/components/ui/SuggestionModal.svelte';
    import ToastContainer from '$lib/components/ToastContainer.svelte';
    import CloseConfirmModal from '$lib/components/CloseConfirmModal.svelte';
    import Workspace, { clearAllWorkspaceTimers, setWorkspaceDisposed } from '$lib/components/Workspace.svelte';
    import AdminDashboard from '$lib/components/AdminDashboard.svelte';
    import { sanitizeNotaHtml } from '$lib/utils/notaContent.js';

    /** The Open WebUI user mapped by identityAdapter.js: `{ id, email, name, role }`, role `beheerder` | `auteur`. */
    export let user;
    /** The container element (`.sa-root`) the bundle was mounted in; provided to children through context. */
    export let rootEl = null;
    /** Called after the app's own close sequence; loader.js unmounts and removes the container. */
    export let onClose = async () => {};

    setContext(ROOT_EL_CONTEXT, rootEl);

    let dbLoaded = false;
    /**
     * True once the page-level configuration load (`loadConfigurationsFromAzure`) has finished, successfully or not.
     * the configurator clones the selected configuration from `dbStore` once and sends that clone with every save
     * the identity is known at mount, so the admin view waits for the load instead of cloning a configuration without its chapters.
     */
    let configsLoaded = false;
    const CONFIG_LOAD_LIMIT_MS = 20000;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let configLoadLimit = null;
    /** @type {{ id: string, email: string, name: string, role: string } | null} */
    let currentUser = user ? { ...user } : null;
    // Everyone lands on the nota overview (identityAdapter.js homeViewFor).
    let currentView = homeViewFor(currentUser); // 'dashboard' | 'editor' | 'admin'
    let activeNotaId = null;
    // "beheerder acts as auteur": a beheerder starts that way (identityAdapter.js startsAsAuthor), so the overview is a
    // working one; the header's "Beheerdersweergave" clears it and opens the configurator, and the header's "Ga naar nota overzicht" sets it again.
    let actingAsAuthor = startsAsAuthor(currentUser);
    let closeConfirmOpen = false;
    /** Which confirmation the open close modal shows (closeSequence.js `closeConfirmationKind`). */
    let closeConfirmKind = 'pending';
    /** The "Terug naar Overzicht" confirmation: asked when "Automatisch Opslaan" is off and the nota has unsaved edits. */
    let backConfirmOpen = false;
    let closing = false;
    /** Set when Svelte destroys this component (unmount): the teardown flags of main.js stay set then. */
    let destroyed = false;
    onDestroy(() => { destroyed = true; if (configLoadLimit) clearTimeout(configLoadLimit); });

    /** Loads Azure configuration templates (access is decided by the Open WebUI identity). */
    async function loadConfigurationsFromAzure() {
        try {
            const res = await storageFetch(`/configurations`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { configurations: configIds } = await res.json();
            for (const configId of (configIds || [])) {
                // Load metadata for display name, version, description
                const metaRes = await storageFetch(`/configurations/${encodeURIComponent(configId)}/metadata`);
                const meta = metaRes.ok ? await metaRes.json() : {};
                dbStore.update(curr => {
                    if (!curr.configurations) curr.configurations = [];
                    let idx = curr.configurations.findIndex(c => c.id === configId);
                    if (idx === -1) {
                        curr.configurations.push({
                            id: configId,
                            name: meta.name || configId,
                            templateVersion: meta.templateVersion || '1.0',
                            description: meta.description || '',
                            toneOfVoice: meta.toneOfVoice || '',
                            isActive: meta.isActive !== undefined ? meta.isActive : true,
                            rules: [],
                            templateGuidelines: [],
                            ...(meta.b1Guidelines !== undefined ? { b1Guidelines: meta.b1Guidelines } : {})
                        });
                    } else {
                        const c = curr.configurations[idx];
                        if (meta.name) c.name = meta.name;
                        if (meta.templateVersion) c.templateVersion = meta.templateVersion;
                        if (meta.description) c.description = meta.description;
                        if (meta.toneOfVoice) c.toneOfVoice = meta.toneOfVoice;
                        if (meta.b1Guidelines !== undefined) c.b1Guidelines = meta.b1Guidelines;
                        c.isActive = meta.isActive !== undefined ? meta.isActive : true;
                    }
                    return { ...curr };
                });

                const sfRes = await storageFetch(`/configurations/${encodeURIComponent(configId)}/subfolders`);
                if (!sfRes.ok) continue;
                const { subfolders } = await sfRes.json();
                for (const subfolder of (subfolders || [])) {
                    const dataRes = await storageFetch(`/configurations/${encodeURIComponent(configId)}/${encodeURIComponent(subfolder)}/data`);
                    if (!dataRes.ok) continue;
                    const { data: folderData } = await dataRes.json();
                    dbStore.update(curr => {
                        if (!curr.configurations) curr.configurations = [];
                        let idx = curr.configurations.findIndex(c => c.id === configId);
                        if (idx === -1) {
                            curr.configurations.push({ id: configId, name: configId, templateVersion: '1.0', description: '', rules: [], templateGuidelines: [] });
                            idx = curr.configurations.length - 1;
                        }
                        const config = curr.configurations[idx];
                        if (subfolder === 'hoofdstukken' || subfolder === 'templates') {
                            config.templateGuidelines = naturalSort(folderData, g => g.id);
                        } else if (subfolder === 'terminologie' || subfolder === 'terms') {
                            config.rules = [...(config.rules || []).filter(r => r.category !== 'Terminologie'), ...folderData];
                        } else if (subfolder === 'regels' || subfolder === 'rules') {
                            config.rules = [...(config.rules || []).filter(r => r.category === 'Terminologie'), ...folderData];
                        }
                        return { ...curr };
                    });
                }
            }
        } catch (e) {
            console.warn('[Azure] Failed to load configurations:', e);
        }
    }

    /** Initialises persisted app data (`initDB`); always sets `dbLoaded` so the UI can render. */
    onMount(async () => {
        try {
            initDB();
            dbLoaded = true;
        } catch (e) {
            console.error("Initialization failed", e);
            dbLoaded = true;
        }
        // A configuration request that never answers must not keep the beheerder on the spinner for ever.
        configLoadLimit = setTimeout(() => { configsLoaded = true; }, CONFIG_LOAD_LIMIT_MS);
        await loadConfigurationsFromAzure();
        if (configLoadLimit) clearTimeout(configLoadLimit);
        configLoadLimit = null;
        configsLoaded = true;
    });

    $: effectiveUser = actingAsAuthor && currentUser ? { ...currentUser, role: 'auteur' } : currentUser;

    // The configurator is for a beheerder only: any other role that ends up on the admin view is sent to the dashboard.
    $: currentView = viewForRole(currentView, currentUser);

    // Close suggestion modal whenever the user leaves the editor.
    $: if (currentView !== 'editor') activeSuggestion.set(null);

    /** True while saving of the active nota is suspended by a 409: the header shows a steady warning. */
    $: activeConflict = !!activeNotaId && $conflictedNotas.has(activeNotaId);

    /**
     * Immediate autosave of the active nota, used when the editor is left and on close.
     * With "Automatisch Opslaan" off nothing is sent unless the auteur asked for it: "Opslaan en sluiten" and
     * "Opslaan en terug" force the save (`force`), whatever the autosave status says.
     * @param {{ force?: boolean }} [opts]
     */
    async function autosaveActiveNota(opts = {}) {
        if (!activeNotaId) return;
        const id = activeNotaId;
        await triggerImmediateAutoSave(id, async () => {
            await syncNotaToAzure(id);
        }, { force: !!opts.force });
    }

    /** "Kopieer mijn versie": the plain text of the version that the backend refused goes to the clipboard. */
    async function copyMyVersion() {
        if (!activeNotaId) return;
        const ok = await copyConflictCopy(activeNotaId);
        addNotification(ok ? 'Je versie is gekopieerd naar het klembord.' : 'Kopiëren is niet gelukt.', ok ? 'success' : 'error', 4000);
    }

    /**
     * Close sequence: the former logout. A conflicted nota, a pending or in-flight save and, with autosave off,
     * unsaved edits ask for confirmation; then the auto-AI and auto-title timers are cleared, the immediate autosave runs with
     * its own timeout and retries, the autosave store is reset, and `onClose` hands over to loader.js.
     */
    async function requestClose() {
        if (closing) return;
        const kind = closeConfirmationKind(get(autoSaveStatus), {
            conflicted: !!activeNotaId && get(conflictedNotas).has(activeNotaId),
            dirtyUnsaved: !!activeNotaId && !get(isAutoSaveEnabled) && isNotaDirty(activeNotaId),
        });
        if (kind && !closeConfirmOpen) {
            closeConfirmKind = kind;
            closeConfirmOpen = true;
            return;
        }
        await performClose();
    }

    /** @param {{ save?: boolean, force?: boolean }} [opts] `save: false` closes without sending the nota (conflict, "Sluiten zonder opslaan") */
    async function performClose(opts = {}) {
        const save = opts.save !== false;
        closing = true;
        closeConfirmOpen = false;
        try {
            await runCloseSequence({
                // the auto-AI countdowns and the auto-title timer live in Workspace (every instance that ever
                // mounted, see `clearAllWorkspaceTimers`); they are cleared BEFORE the awaited save, so none of them
                // fires while a slow or retried PUT is in flight. The save itself cancels the autosave debounce.
                beforeSave: () => {
                    clearAllWorkspaceTimers();
                    // an answer that arrives while the save is awaited cannot arm a new debounce for an app that is leaving.
                    setAutosaveTornDown(true);
                },
                autosave: () => (save ? autosaveActiveNota({ force: !!opts.force }) : Promise.resolve()),
                reset: () => {
                    resetAutoSaveState();
                },
                afterSave: () => {
                    activeNotaId = null;
                    actingAsAuthor = startsAsAuthor(currentUser);
                    // back to the start view before the host unmounts, so a missing or failing onClose leaves a coherent screen
                    currentView = homeViewFor(currentUser);
                },
                onClose,
            });
        } finally {
            closing = false;
            // When the host did not unmount (no loader, a failing onClose) the app stays usable: arm the timers again.
            if (!destroyed) {
                setWorkspaceDisposed(false);
                setAutosaveTornDown(false);
            }
        }
    }

    /**
     * Adds a nota to `dbStore` with H2 blocks from template guidelines and opens the editor.
     * @param {{ configId?: string }} detail
     */
    function createNewNota(detail) {
        console.log("Creating new nota with detail:", detail);
        const configId = detail?.configId;

        const db = get(dbStore);
        const newId = 'n' + (Date.now());
        const config = db.configurations?.find(c => c.id === configId) || db.configurations?.[0];

        let initialContent = '';
        if (config && config.templateGuidelines && config.templateGuidelines.length > 0) {
            const sortedGuidelines = naturalSort(config.templateGuidelines, g => g.id);
            initialContent = sortedGuidelines.map(g => {
                const instructie = (g.instructie || '').trim();
                const body = instructie ? `\n<p><i>${instructie}</i></p>` : '';
                return `<h2 class="dynamic-chapter" data-chapter-id="${g.id}">${g.titel}</h2>${body}\n`;
            }).join('\n');
        } else {
            initialContent = `<h2 class="dynamic-chapter" data-chapter-id="c1">Onderwerp kort en duidelijk weergeven</h2>\n<p><i>Schrijf hier een korte, krachtige titel.</i></p>\n`;
        }
        // SAFETY: chapter ids, titles and instructions come from a configuration that a beheerder, or a file the
        // beheerder imported, controls. They are written into the nota as HTML above; the safety filter returns a clean string
        // byte for byte and removes markup that could run, so such a configuration cannot put a payload into a stored nota.
        initialContent = sanitizeNotaHtml(initialContent);

        const newNota = {
            id: newId,
            title: "Nieuwe Concept Nota",
            titleManuallySet: false,
            status: "WIP",
            lastModified: new Date().toISOString(),
            configId: config?.id || 'conf-gs',
            configName: config?.name || 'GS-Nota',
            templateVersion: config?.templateVersion || "v1.0",
            toneOfVoice: config?.toneOfVoice || "Zakelijk",
            allowedWords: config?.allowedWords || [],
            authors: [effectiveUser.name],
            reviewers: [],
            content: initialContent,
            notes: [],
            shortSummary: ''
        };
        db.notas.unshift(newNota);
        dbStore.set({ ...db });
        saveDB();

        console.log("New nota created:", newId);
        activeNotaId = newId;
        currentView = 'editor';
    }

    /** Opens an existing nota in the workspace (`activeNotaId`). */
    async function handleOpenNota(detail) {
        console.log("Opening nota:", detail.id);

        // Trigger autosave for the currently active nota before switching
        if (activeNotaId && activeNotaId !== detail.id) {
            await autosaveActiveNota();
        }

        activeNotaId = detail.id;
        currentView = 'editor';
    }

    /**
     * "Als auteur werken": a beheerder opens the dashboard acting as auteur. The header's "Terug naar
     * "Beheerdersweergave" button (`onnavAdmin`) opens the admin view and clears the flag.
     */
    function workAsAuthor() {
        if (!currentUser || currentUser.role !== 'beheerder') return;
        actingAsAuthor = true;
        currentView = 'dashboard';
    }

    let workspaceRef;

    /** Manually saves the active nota to Azure Storage. */
    async function handleSaveActiveNota() {
        if (!activeNotaId) return;
        try {
            await workspaceRef?.triggerTitleGenerationOnManualSave?.();
            await syncNotaToAzure(activeNotaId);
            addNotification('Nota succesvol opgeslagen in cloud storage!', 'success');
        } catch (e) {
            // A refused save (409) was already reported by store.js; a nota that is still in conflict sends nothing and says why here.
            if (!(e && e.name === 'NotaConflictError' && e.reported)) addNotification(`Opslaan mislukt: ${e.message}`, 'error');
        }
    }

    /**
     * Leaving the editor for the overview: the header's "Terug naar Overzicht" and the logo (`onnavDashboard`) and the
     * Workspace's `onback`. The dashboard replaces `dbStore.notas` with the stored list when it mounts, so an edit that is
     * still waiting for the debounce has to be saved before the view changes (closeSequence.js `leaveEditorAction`):
     * a pending edit is saved first; with "Automatisch Opslaan" off the auteur is asked; a failed save keeps the editor
     * open so nothing is silently lost; a conflicted nota is left as it is, because reloading the list is its recovery.
     */
    async function handleBackFromEditor() {
        if (!activeNotaId) { leaveEditor(); return; }
        const id = activeNotaId;
        const action = leaveEditorAction(get(autoSaveStatus), {
            conflicted: get(conflictedNotas).has(id),
            autosaveOn: get(isAutoSaveEnabled),
            dirty: isNotaDirty(id),
        });
        if (action === 'ask') { backConfirmOpen = true; return; }
        if (action === 'save' && !(await saveBeforeLeaving())) return;
        leaveEditor();
    }

    /**
     * The immediate save that precedes leaving the editor. Resolves `false` when the save failed (after its retries),
     * so the caller keeps the editor open; a 409 is not a failure here: the nota is then conflicted and the overview is its recovery.
     * @param {{ force?: boolean }} [opts] `force`: the auteur chose "Opslaan en terug" with autosave off
     */
    async function saveBeforeLeaving(opts = {}) {
        const id = activeNotaId;
        await autosaveActiveNota(opts);
        if (get(autoSaveStatus) === 'error' && !get(conflictedNotas).has(id)) {
            addNotification('Niet teruggegaan: de nota kon niet worden opgeslagen. Probeer "Opslaan" opnieuw of kopieer je tekst.', 'error', 6000);
            return false;
        }
        return true;
    }

    /** Shows the overview (or the admin view) and forgets the active nota: the dashboard's list is the truth from here. */
    function leaveEditor() {
        backConfirmOpen = false;
        currentView = homeViewFor(currentUser, actingAsAuthor);
        activeNotaId = null;
    }
</script>

{#if !dbLoaded}
    <div style="padding: 40px; text-align: center;">
        <i class="ph-bold ph-circle-notch ph-spin" style="font-size: 2rem; color: var(--sa-primary-text);"></i>
        <p style="margin-top: 1rem;">Bezig met laden...</p>
    </div>
{:else}
    <div class="app-container">
        <Header
            {currentUser}
            originalUser={currentUser}
            {currentView}
            onclose={requestClose}
            onnavDashboard={handleBackFromEditor}
            onnavAdmin={() => {
                actingAsAuthor = false;
                currentView = 'admin';
            }}
            onworkAsAuthor={workAsAuthor}
            onsave={handleSaveActiveNota}
            conflict={activeConflict}
            oncopyConflict={copyMyVersion}
        />
        {#if currentView === 'dashboard'}
            <NotaDashboard
                currentUser={effectiveUser}
                onopenNota={handleOpenNota}
                oncreateNota={createNewNota}
            />
        {:else if currentView === 'editor'}
            <Workspace
                bind:this={workspaceRef}
                currentUser={effectiveUser}
                notaId={activeNotaId}
                onback={handleBackFromEditor}
            />
        {:else if currentView === 'admin'}
            {#if configsLoaded}
                <AdminDashboard {currentUser} />
            {:else}
                <div class="main-content sa-stub-view" data-admin-loading="true">
                    <i class="ph-bold ph-circle-notch ph-spin" style="font-size: 2rem; color: var(--sa-primary-text);"></i>
                    <p style="margin-top: 1rem;">Configuraties laden...</p>
                </div>
            {/if}
        {/if}
    </div>
{/if}

{#if closeConfirmOpen}
    <CloseConfirmModal
        status={closeConfirmKind === 'pending' || closeConfirmKind === 'saving' ? $autoSaveStatus : closeConfirmKind}
        onConfirm={() => performClose({ force: true })}
        onDiscard={() => performClose({ save: false })}
        onCopy={copyMyVersion}
        onCancel={() => closeConfirmOpen = false}
    />
{/if}

{#if backConfirmOpen}
    <CloseConfirmModal
        action="back"
        status="unsaved"
        onConfirm={async () => { if (await saveBeforeLeaving({ force: true })) leaveEditor(); else backConfirmOpen = false; }}
        onDiscard={leaveEditor}
        onCancel={() => backConfirmOpen = false}
    />
{/if}

<SuggestionModal />
<ToastContainer />
