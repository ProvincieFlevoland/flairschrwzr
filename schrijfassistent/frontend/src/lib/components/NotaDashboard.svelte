<script>
    /** Home screen: nota list from `dbStore`, open/create/delete with status badges. */
    import { onMount } from 'svelte';
    import { dbStore, saveDB, syncNotaToAzure, isNotaSyncing, waitForNotaSync, rememberNotaBase, forgetNotaBase } from '../store.js';
    import { cancelDebounceTimer, getCurrentNotaId } from '$lib/autosaveStore.js';
    import { addNotification } from '$lib/notificationStore.js';
    import NewNotaModal from './NewNotaModal.svelte';
    import DeleteConfigModal from './DeleteConfigModal.svelte';
    import { storageFetch, describeApiUnreachableError } from '$lib/apiClient.js';
    import { sanitizeNotaHtml } from '$lib/utils/safetyFilter.js';

    let notasLoading = true;
    let notasLoadError = '';

    /**
     * Normalises nota objects from the API so the list UI never sees missing array fields.
     * @param {unknown[]} raw - Raw `notas` array from the storage response.
     */
    function normalizeNotaList(raw) {
        return (raw || []).map((n) => ({
            ...n,
            // SAFETY: nota HTML passes through the safety filter on load; a clean nota comes back as the same string.
            ...(typeof n?.content === 'string' ? { content: sanitizeNotaHtml(n.content) } : {}),
            authors: Array.isArray(n?.authors) ? n.authors : [],
            reviewers: Array.isArray(n?.reviewers) ? n.reviewers : [],
            notes: Array.isArray(n?.notes) ? n.notes : [],
            shortSummary: typeof n?.shortSummary === 'string' ? n.shortSummary : ''
        }));
    }

    /** First load: fetches all nota metadata from Azure and replaces `dbStore.notas`. */
    onMount(async () => {
        try {
            const res = await storageFetch(`/notas`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const azureNotas = normalizeNotaList(data.notas);
            rememberNotaBase(azureNotas); // base for X-Nota-Base-Modified
            dbStore.update(s => ({ ...s, notas: azureNotas }));
        } catch (e) {
            notasLoadError = e.message;
            console.warn('[Azure] Failed to load notas:', e);
        } finally {
            notasLoading = false;
        }
    });

    export let onopenNota = (detail) => {};
    export let oncreateNota = (detail) => {};

    export let currentUser;

    let selectedNotaId = null;

    /** Most recently adjusted notas first; items without `lastModified` sink to the bottom. */
    function sortNotasByRecent(notas) {
        return [...notas].sort((a, b) => {
            const tA = a.lastModified ? Date.parse(a.lastModified) : 0;
            const tB = b.lastModified ? Date.parse(b.lastModified) : 0;
            return tB - tA;
        });
    }

    /** Reactive source for the list, sorted by `lastModified` descending. */
    $: n = sortNotasByRecent($dbStore.notas || []);
    $: selectedNota = selectedNotaId ? n.find((nota) => nota.id === selectedNotaId) ?? null : null;

    let showNewModal = false;
    let showDeleteConfirm = false;
    let notaIdToDelete = null;
    let notaTitleToDelete = "";

    /** Notifies the parent that the user wants to open a nota (navigate to editor). */
    function openNota(id) {
        onopenNota({ id });
    }

    /** Closes the modal and starts creation with the chosen configuration id. */
    function createNewNota(event) {
        showNewModal = false;
        oncreateNota({ configId: event.configId });
    }

    /** Opens the secure delete confirmation modal for a nota. */
    async function deleteNota(id) {
        const nota = n.find(nt => nt.id === id);
        if (!nota) return;

        notaIdToDelete = id;
        notaTitleToDelete = nota.title || id;
        showDeleteConfirm = true;
    }

    /** The actual deletion logic, called after the user confirms in the modal. */
    async function handleDeleteConfirm() {
        const id = notaIdToDelete;
        showDeleteConfirm = false;

        // Race condition protection: wait for any pending sync to complete
        if (isNotaSyncing(id)) {
            addNotification('Nota wordt gesynchroniseerd, even geduld...', 'info', 2000);
            const completed = await waitForNotaSync(id, 3000);
            if (!completed) {
                addNotification('Sync timeout - de nota kan mogelijk nog in gebruik zijn', 'warning', 4000);
            }
        }

        // Cancel any pending autosave timer for this nota
        if (getCurrentNotaId() === id) {
            cancelDebounceTimer();
        }

        dbStore.update(s => ({ ...s, notas: s.notas.filter(n => n.id !== id) }));
        saveDB();

        if (selectedNotaId === id) selectedNotaId = null;

        try {
            await storageFetch(`/notas/${encodeURIComponent(id)}`, { method: 'DELETE' });
            forgetNotaBase(id);
            addNotification('Nota succesvol verwijderd', 'success', 2000);
        } catch (e) {
            console.warn('[Azure] Failed to delete nota blob:', e);
            addNotification('Lokaal verwijderd, maar Azure sync mislukt', 'warning', 3000);
        }

        notaIdToDelete = null;
        notaTitleToDelete = "";
    }

    /** CSS class for the status chip (WIP / Final-draft / Final). */
    function getStatusBadgeClass(status) {
        switch (status) {
            case 'WIP': return 'sa-badge-draft';
            case 'Final-draft': return 'sa-badge-review';
            case 'Final': return 'sa-badge-success';
            default: return '';
        }
    }

    /** Human-readable Dutch label for nota status (UI copy). */
    function getStatusBadgeLabel(status) {
         switch (status) {
            case 'WIP': return 'Concept (WIP)';
            case 'Final-draft': return 'Ter Review (Final-draft)';
            case 'Final': return 'Definitief (Final)';
            default: return status;
        }
    }

    /** Short date+time string for `lastModified` in the list. */
    function formatDate(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    let summaryLoading = false;
    let summaryError = '';

    $: if (selectedNotaId) summaryError = '';

    /** Lines for displaying stored short summary (same list style as reviewers). */
    function shortSummaryLines(text) {
        return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }

    import { extractChaptersFromHtml } from '$lib/utils/notaContent.js';

    /** Parses HTML content into blocks by h2.dynamic-chapter and returns plain text per chapter. */
    function extractChapters(htmlContent) {
        return extractChaptersFromHtml(htmlContent);
    }

    /**
     * Builds chapters from the selected nota's HTML, calls `/summarize-nota`,
     * writes up to three lines of `shortSummary` to the store, saves locally and attempts Azure sync.
     */
    async function makeSummary() {
        if (!selectedNota) return;
        const id = selectedNota.id;
        summaryLoading = true;
        summaryError = '';

        const chapters = extractChapters(selectedNota.content);
        if (!chapters.length) {
            summaryError = 'Geen inhoud gevonden om samen te vatten.';
            summaryLoading = false;
            return;
        }

        try {
            const response = await storageFetch(`/summarize-nota`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chapters })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${response.status}`);
            }
            const data = await response.json();
            const text = (data.summary || '').trim();
            const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
            const shortSummary = lines.join('\n');

            dbStore.update((s) => {
                const idx = s.notas.findIndex((n) => n.id === id);
                if (idx === -1) return s;
                const next = [...s.notas];
                next[idx] = {
                    ...next[idx],
                    shortSummary,
                    lastModified: new Date().toISOString()
                };
                return { ...s, notas: next };
            });
            saveDB();
            try {
                await syncNotaToAzure(id);
            } catch (syncErr) {
                console.warn('[Azure] Samenvatting lokaal opgeslagen; cloud-sync mislukt:', syncErr);
            }
        } catch (e) {
            summaryError = e.message || describeApiUnreachableError();
        } finally {
            summaryLoading = false;
        }
    }

    $: configurations = $dbStore.configurations || [];
    /** Display name of the linked configuration (fallback GS-Nota). */
    function getConfigName(nota) {
        if (nota.configName) return nota.configName;
        const config = configurations.find(c => c.id === (nota.configId || 'conf-gs'));
        return config ? config.name : 'GS-Nota';
    }
</script>

<style>
    /* Svelte-scoped styles kept; rooted at .sa-root so the build-time scope check passes. */
    :global(.sa-root) .nota-list-item {
        width: 100%;
        text-align: left;
        background: var(--sa-bg-panel);
        font-family: inherit;
        border: 1px solid var(--sa-border-color);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 12px;
        cursor: pointer;
        transition: all 0.2s;
        display: block;
    }
    :global(.sa-root) .nota-list-item:hover {
        box-shadow: var(--sa-shadow-sm);
        border-color: #cbd5e1;
    }
    :global(.sa-root) .nota-list-item.active {
        border-left: 4px solid var(--sa-primary-color);
        border-color: var(--sa-primary-color);
    }
    /* Dark twin of the hover border, here and not in dark.css: the Svelte hash class makes the base rule one
       class heavier than a twin in dark.css, which would then lose; this rule carries the same hash. */
    :global(.dark) :global(.sa-root) .nota-list-item:hover {
        border-color: #4b5563;
    }
    /* Known behaviour: the inline `animation: spin` references (below, three spinners) never match a scoped
       `@keyframes spin` (Svelte hashes the name), so the dashboard spinners do not rotate. No keyframe is emitted. */
</style>

<div class="dashboard-layout">
    <div class="dashboard-list sa-flex-2">
        <div style="padding: 24px; border-bottom: 1px solid var(--sa-border-color); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;">
            <h2 style="margin: 0;">Recente GS-Nota's</h2>
            <div style="display: flex; align-items: center; gap: 12px; flex-shrink: 0; margin-left: auto;">
                {#if notasLoading}
                    <span style="color: var(--sa-text-muted); font-size: 0.875rem; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;">
                        <i class="ph-bold ph-spinner" aria-hidden="true" style="animation: spin 1s linear infinite;"></i> Nota's laden...
                    </span>
                {:else if notasLoadError}
                    <span style="color: var(--sa-color-danger, #dc2626); font-size: 0.8125rem; max-width: min(420px, 45vw);">
                        Kon nota's niet laden vanuit Azure: {notasLoadError}
                    </span>
                {/if}
                {#if currentUser.role === 'auteur'}
                    <button class="sa-btn sa-btn-primary" on:click={() => showNewModal = true}>
                        <i class="ph-bold ph-plus" aria-hidden="true"></i> Nieuwe Nota
                    </button>
                {/if}
            </div>
        </div>

        <div class="nota-list">
            {#each n as nota (nota.id)}
                <button
                    class="nota-list-item {selectedNotaId === nota.id ? 'active' : ''}"
                    on:click={() => selectedNotaId = nota.id}
                    on:keydown={(e) => { if (e.key === 'Enter') selectedNotaId = nota.id; }}
                    type="button"
                >
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <h3 style="font-size: 1rem; margin: 0;">{nota.title}</h3>
                        <span class={getStatusBadgeClass(nota.status)}>{getStatusBadgeLabel(nota.status)}</span>
                    </div>
                    <div style="font-size: 0.8rem; color: var(--sa-text-muted); display: flex; gap: 16px; padding-top: 4px;">
                        <span><i class="ph-bold ph-users" aria-hidden="true"></i> {(nota.authors || []).join(', ') || '—'}</span>
                        <span><i class="ph-bold ph-chat-text" aria-hidden="true"></i> {nota.notes ? nota.notes.length : 0} notities</span>
                        {#if nota.lastModified}
                            <span><i class="ph-bold ph-clock" aria-hidden="true"></i> Laatst bewerkt: {formatDate(nota.lastModified)}</span>
                        {/if}
                    </div>
                </button>
            {/each}
        </div>
    </div>

    <div class="dashboard-sidebar sa-flex-1">
        {#if selectedNota}
            <div style="padding: 24px;">
                <h3 style="margin-bottom: 16px;">{selectedNota.title}</h3>

                <div class="detail-group">
                    <span class="detail-label">Status</span>
                    <div><span class={getStatusBadgeClass(selectedNota.status)}>{getStatusBadgeLabel(selectedNota.status)}</span></div>
                </div>

                <div class="detail-group">
                    <span class="detail-label">Gebruikte Sjabloon</span>
                    <div style="font-weight: 500; margin-bottom: 4px; color: var(--sa-text-main);">{getConfigName(selectedNota)}</div>
                    <div style="display: inline-block" class="version-badge">{selectedNota.templateVersion}</div>
                </div>

                <div class="detail-group">
                    <span class="detail-label">Auteurs</span>
                    <ul style="margin: 0; padding-left: 20px; font-size: 0.875rem;">
                        {#each selectedNota.authors || [] as author}
                            <li>{author}</li>
                        {/each}
                    </ul>
                </div>

                <div class="detail-group">
                    <span class="detail-label">Reviewers (Notities achtergelaten)</span>
                    {#if selectedNota.reviewers && selectedNota.reviewers.length > 0}
                        <ul style="margin: 0; padding-left: 20px; font-size: 0.875rem;">
                            {#each selectedNota.reviewers as reviewer}
                                <li>{reviewer}</li>
                            {/each}
                        </ul>
                    {:else}
                        <div style="font-size: 0.875rem; color: var(--sa-text-muted);">Nog geen reviews</div>
                    {/if}
                </div>

                <div class="detail-group">
                    <span class="detail-label">Waar gaat deze nota over?</span>
                    {#if summaryLoading}
                        <div style="font-size: 0.875rem; color: var(--sa-text-muted);">
                            <i class="ph-bold ph-spinner" aria-hidden="true" style="animation: spin 1s linear infinite;"></i>
                            Samenvatting maken…
                        </div>
                    {:else if summaryError}
                        <div style="font-size: 0.875rem; color: var(--sa-color-danger, #dc2626);">{summaryError}</div>
                    {:else if shortSummaryLines(selectedNota.shortSummary).length}
                        <ul style="margin: 0; padding-left: 20px; font-size: 0.875rem;">
                            {#each shortSummaryLines(selectedNota.shortSummary) as line}
                                <li>{line}</li>
                            {/each}
                        </ul>
                    {:else}
                        <div style="font-size: 0.875rem; color: var(--sa-text-muted);">
                            Nog geen korte omschrijving. Gebruik de knop hieronder.
                        </div>
                    {/if}
                </div>

                <div style="margin-top: 32px; display: flex; flex-direction: column; gap: 8px;">
                    {#if currentUser.role === 'auteur'}
                        <button class="sa-btn sa-btn-primary" style="width: 100%; justify-content: center;" on:click={() => openNota(selectedNota.id)}>
                            <i class="ph-bold ph-pencil-simple" aria-hidden="true"></i> Bewerk Nota
                        </button>
                    {/if}
                    {#if currentUser.role === 'reviewer'}
                        <button class="sa-btn sa-btn-primary" style="width: 100%; justify-content: center;" on:click={() => openNota(selectedNota.id)}>
                            <i class="ph-bold ph-magnifying-glass" aria-hidden="true"></i> Bekijk & Toets Nota
                        </button>
                    {/if}
                    {#if currentUser.role === 'beheerder'}
                        <div style="color: var(--sa-text-muted); font-size: 0.85rem; text-align: center;">Beheerders kunnen nota's niet inhoudelijk bewerken.</div>
                    {/if}

                    <button
                        class="sa-btn sa-btn-secondary"
                        style="width: 100%; justify-content: center;"
                        on:click={makeSummary}
                        disabled={summaryLoading}
                    >
                        {#if summaryLoading}
                            <i class="ph-bold ph-spinner" aria-hidden="true" style="animation: spin 1s linear infinite;"></i> Samenvatting maken...
                        {:else}
                            <i class="ph-bold ph-list-bullets" aria-hidden="true"></i> Maak Samenvatting
                        {/if}
                    </button>

                    {#if currentUser.role === 'beheerder' || (currentUser.role === 'auteur' && selectedNota.status === 'WIP')}
                        <button class="sa-btn sa-btn-danger" style="width: 100%; justify-content: center;" on:click={() => deleteNota(selectedNota.id)}>
                            <i class="ph-bold ph-trash" aria-hidden="true"></i> Verwijder Nota
                        </button>
                    {/if}
                </div>

            </div>
        {:else}
            <div style="padding: 40px; text-align: center; color: var(--sa-text-muted);">
                <i class="ph-bold ph-file-text" style="font-size: 48px; margin-bottom: 16px;"></i>
                <p>Selecteer een nota uit de lijst om details te bekijken.</p>
            </div>
        {/if}
    </div>
</div>

{#if showNewModal}
    <NewNotaModal onclose={() => showNewModal = false} onselect={createNewNota} />
{/if}

{#if showDeleteConfirm}
    <DeleteConfigModal
        itemName={notaTitleToDelete}
        itemType="nota"
        onConfirm={handleDeleteConfirm}
        onCancel={() => showDeleteConfirm = false}
    />
{/if}
