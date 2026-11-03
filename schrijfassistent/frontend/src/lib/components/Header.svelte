<script>
    /**
     * App header: logo/title, back to dashboard/admin, user badge + close.
     * Port notes: the former logout control (the user badge) is the close button and calls
     * `onclose` (App.svelte `requestClose`). The chat-mode toggle is removed. The build version is
     * shown in the gear menu. The logo is served from `config.asset_base_url`.
     */
    import { fade } from 'svelte/transition';
    import { uiSettings } from '$lib/uiStore.js';
    import { isAutoSaveEnabled, autoSaveStatus } from '$lib/autosaveStore.js';
    import { assetBaseUrl, BUILD_DATE, BUILD_HASH } from '$lib/config.js';
    import { dialogFocus } from '$lib/utils/dialogFocus.js';
    import './Header.css';

    export let onclose = () => {};
    export let onnavDashboard = () => {};
    export let onnavAdmin = () => {};
    /** "Ga naar nota overzicht" in the configurator: the beheerder opens the overview acting as auteur (App.svelte workAsAuthor). */
    export let onworkAsAuthor = () => {};
    export let onsave = async () => {};
    /** True while saving of the active nota is suspended by a 409 (store.js `conflictedNotas`); shows the steady warning. */
    export let conflict = false;
    export let oncopyConflict = async () => {};

    export let currentUser = null;
    export let originalUser = null;
    export let currentView = 'dashboard';

    let isSaving = false;
    let settingsOpen = false;

    async function handleSave() {
        isSaving = true;
        try {
            await onsave();
        } finally {
            setTimeout(() => isSaving = false, 1000);
        }
    }
</script>

<header class="app-header">
    <div
        class="header-left"
        style="cursor: pointer;"
        role="button"
        tabindex="0"
        on:click={onnavDashboard}
        on:keydown={(e) => { if (e.key === 'Enter') onnavDashboard(); }}
    >
        <img src="{assetBaseUrl()}/logo_flevoland.png" alt="Flevoland Logo" style="height: 60px; width: auto; object-fit: contain; margin-right: 4px;" />
        <span class="header-title">GovChatNL - Flevoland Schrijfassistent GS-nota</span>
    </div>

    <div class="header-right">
        {#if currentView === 'editor'}
            {#if conflict}
                <div class="sa-header-conflict" role="alert" data-testid="conflict-indicator">
                    <i class="ph-bold ph-warning" aria-hidden="true"></i>
                    <span>Niet opgeslagen: de nota is intussen door iemand anders gewijzigd. Kopieer je versie en open de nota opnieuw via het overzicht.</span>
                    <button class="sa-header-conflict-btn" data-testid="conflict-copy" on:click={oncopyConflict}>Kopieer mijn versie</button>
                </div>
            {/if}
            <div style="display: flex; align-items: center; gap: 4px; margin-right: 12px;">
                {#if $autoSaveStatus === 'success'}
                    <i class="ph-bold ph-check-circle" role="img" aria-label="Automatisch opgeslagen" style="font-size: 1.25rem; color: #10b981;" title="Automatisch opgeslagen" transition:fade={{ duration: 200 }}></i>
                {:else if $autoSaveStatus === 'error'}
                    <i class="ph-bold ph-warning-circle" role="img" aria-label="Autosave mislukt" style="font-size: 1.25rem; color: #ef4444;" title="Autosave mislukt" transition:fade={{ duration: 200 }}></i>
                {/if}
                <button class="sa-btn sa-btn-primary" on:click={handleSave} disabled={isSaving}>
                    {#if isSaving}
                        <i class="ph-bold ph-spinner-gap ph-spin"></i> Bezig...
                    {:else}
                        <i class="ph-bold ph-cloud-arrow-up" aria-hidden="true"></i> Opslaan
                    {/if}
                </button>
            </div>
            <button class="sa-btn sa-btn-secondary" on:click={onnavDashboard} style="margin-right: 16px;">
                <i class="ph-bold ph-arrow-left" aria-hidden="true"></i> Terug naar Overzicht
            </button>
        {/if}
        {#if originalUser && originalUser.role === 'beheerder' && currentView !== 'admin'}
            <button class="sa-btn sa-btn-secondary" on:click={onnavAdmin} style="margin-right: 16px;">
                <i class="ph-bold ph-shield-star" aria-hidden="true"></i> Beheerdersweergave
            </button>
        {:else if originalUser && originalUser.role === 'beheerder' && currentView === 'admin'}
            <!-- the same place and look as "Beheerdersweergave" on the overview; the way back for a beheerder -->
            <button class="sa-btn sa-btn-secondary" data-action="work-as-author" on:click={onworkAsAuthor} style="margin-right: 16px;">
                <i class="ph-bold ph-list-bullets" aria-hidden="true"></i> Ga naar nota overzicht
            </button>
        {/if}

        <!-- Settings gear -->
        {#if currentUser?.role === 'auteur'}
            <div style="position: relative; margin-right: 12px;">
                <button
                    class="sa-btn sa-btn-secondary"
                    title="Instellingen"
                    aria-label="Instellingen"
                    on:click|stopPropagation={() => settingsOpen = !settingsOpen}
                >
                    <i class="ph-bold ph-gear" style="font-size: 1rem; line-height: 1;"></i>
                </button>
                {#if settingsOpen}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <div class={'sa-header-settings-dropdown'} on:click|stopPropagation={() => {}} use:dialogFocus={{ onClose: () => settingsOpen = false }}>
                        <div class={'sa-header-settings-dropdown-title'}>Instellingen</div>
                        <label class={'sa-header-settings-row'}>
                            <span class={'sa-header-settings-label'}>
                                <i class="ph-bold ph-sparkle"></i> Auto-AI na typen
                                <span class={'sa-header-settings-hint'}>AI analyseert automatisch na 10 seconden inactiviteit</span>
                            </span>
                            <button
                                role="switch"
                                aria-checked={$uiSettings.autoAi}
                                class="{'sa-header-settings-toggle'} {$uiSettings.autoAi ? 'sa-header-on' : ''}"
                                on:click={() => uiSettings.toggle('autoAi')}
                            >
                                <span class={'sa-header-settings-toggle-knob'}></span>
                            </button>
                        </label>
                        <label class={'sa-header-settings-row'}>
                            <span class={'sa-header-settings-label'}>
                                <i class="ph-bold ph-floppy-disk"></i> Automatisch Opslaan
                                <span class={'sa-header-settings-hint'}>Wijzigingen worden automatisch naar Azure gesynct na 10 seconden inactiviteit</span>
                            </span>
                            <button
                                role="switch"
                                aria-checked={$isAutoSaveEnabled}
                                class="{'sa-header-settings-toggle'} {$isAutoSaveEnabled ? 'sa-header-on' : ''}"
                                on:click={() => isAutoSaveEnabled.toggle()}
                            >
                                <span class={'sa-header-settings-toggle-knob'}></span>
                            </button>
                        </label>
                        <label class={'sa-header-settings-row'}>
                            <span class={'sa-header-settings-label'}>
                                <i class="ph-bold ph-chart-bar"></i> Direct Duidelijk metrics
                                <span class={'sa-header-settings-hint'}>Toon indicatieve leesbaarheidsmetingen bovenaan het tabblad Direct Duidelijk</span>
                            </span>
                            <button
                                role="switch"
                                aria-checked={$uiSettings.showDdMetrics}
                                class="{'sa-header-settings-toggle'} {$uiSettings.showDdMetrics ? 'sa-header-on' : ''}"
                                on:click={() => uiSettings.toggle('showDdMetrics')}
                            >
                                <span class={'sa-header-settings-toggle-knob'}></span>
                            </button>
                        </label>
                        <div class="sa-header-settings-version" title="Versie van de Schrijfassistent">
                            Versie: {BUILD_DATE} • <span style="font-family: monospace;">{BUILD_HASH}</span>
                        </div>
                        <!-- attribution of the OpenTaal word list that the Direct Duidelijk lexicons are derived from -->
                        <div class="sa-header-settings-attribution" data-testid="opentaal-attribution">
                            Woordenlijst: OpenTaal (opentaal.org), licentie BSD 3-Clause / CC BY 3.0 (OpenTaal). De Direct Duidelijk-woordenlijsten zijn hieruit afgeleid.
                        </div>
                    </div>
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <div class={'sa-header-settings-backdrop'} on:click={() => settingsOpen = false}></div>
                {/if}
            </div>
        {/if}

        <div class="user-badge" on:click={onclose} on:keydown={(e) => { if (e.key === 'Enter') onclose(); }} role="button" tabindex="0" title="Schrijfassistent sluiten" aria-label="Schrijfassistent sluiten" style="cursor: pointer;">
            <i class="ph-bold ph-user-circle" aria-hidden="true"></i>
            <span style="font-weight: 600; font-size: 0.875rem;">{currentUser?.name}</span>
            <span style="font-size: 0.75rem; color: var(--sa-text-muted); text-transform: capitalize;">({currentUser?.role})</span>
            <i class="ph-bold ph-x sa-header-close-icon" aria-hidden="true"></i>
        </div>
    </div>
</header>

