<script>
    /** Modal: pick a `configurations` entry and confirm to start a new nota. */
    import { dbStore } from '../store.js';
    import { dialogFocus } from '../utils/dialogFocus.js';
    import './NewNotaModal.css';

    export let onselect = (detail) => {};
    export let onclose = () => {};

    // Only show active configurations when creating a new nota
    // Filter out: 'notas' folder, and configs that are not explicitly active
    $: configurations = ($dbStore.configurations || [])
        .filter(c => c.id !== 'notas') // Exclude the 'notas' folder
        .filter(c => c.isActive === true) // Only show explicitly active configs (default false if not set)
        .map(c => ({
            ...c,
            isActive: c.isActive !== undefined ? c.isActive : false
        }));
    let selectedConfigId = null;

    $: selectedConfig = configurations.find(c => c.id === selectedConfigId);

    /** Calls `onselect` with the chosen `configId`. */
    function handleStart() {
        if (!selectedConfigId) return;
        onselect({ configId: selectedConfigId });
    }

    /** Closes modal without action. */
    function handleCancel() {
        onclose();
    }
</script>

<div class={'sa-new-nota-modal-modal-backdrop'} on:click|self={handleCancel} role="presentation">
    <div class={'sa-new-nota-modal-modal-content'} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" use:dialogFocus={{ onClose: handleCancel }}>
        <div class={'sa-new-nota-modal-modal-header'}>
            <h2 id="modal-title">Nieuwe Nota Starten</h2>
            <button class={'sa-new-nota-modal-btn-close'} on:click={handleCancel} aria-label="Sluiten"><i class="ph ph-x" aria-hidden="true"></i></button>
        </div>

        <div class={'sa-new-nota-modal-modal-body'}>
            <p>Selecteer het type document en de bijbehorende tool-configuratie om te beginnen.</p>

            <div class={'sa-new-nota-modal-config-grid'}>
                {#each configurations as config}
                    <button
                        class="{'sa-new-nota-modal-config-card'} {selectedConfigId === config.id ? 'sa-new-nota-modal-active' : ''}"
                        on:click={() => selectedConfigId = config.id}
                        type="button"
                    >
                        <div class={'sa-new-nota-modal-config-icon'}>
                            <i class="ph-bold {config.id === 'conf-gs' ? 'ph-file-text' : 'ph-flask'}" aria-hidden="true"></i>
                        </div>
                        <div class={'sa-new-nota-modal-config-info'}>
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <h3>{config.name}</h3>
                                <span class={'sa-new-nota-modal-version-badge'}>{config.templateVersion}</span>
                            </div>
                            <p>{config.description}</p>
                        </div>
                        {#if selectedConfigId === config.id}
                            <div class={'sa-new-nota-modal-config-check'}>
                                <i class="ph-bold ph-check" aria-hidden="true"></i>
                            </div>
                        {/if}
                    </button>
                {/each}
            </div>

            {#if selectedConfig}
                <div class={'sa-new-nota-modal-config-details-panel'}>
                    <h4>Tool Configuratie Details</h4>
                    <div class={'sa-new-nota-modal-details-grid'}>
                        <div class={'sa-new-nota-modal-detail-item'}>
                            <span class={'sa-new-nota-modal-label'}>Tone of Voice:</span>
                            <span class={'sa-new-nota-modal-value'}>{selectedConfig.toneOfVoice}</span>
                        </div>
                        <div class={'sa-new-nota-modal-detail-item'}>
                            <span class={'sa-new-nota-modal-label'}>Sjabloon Versie:</span>
                            <span class={'sa-new-nota-modal-value'}>{selectedConfig.templateVersion}</span>
                        </div>
                        <div class={'sa-new-nota-modal-detail-item'}>
                            <span class={'sa-new-nota-modal-label'}>Geselecteerde Secties:</span>
                            <div class={'sa-new-nota-modal-tags'}>
                                {#each selectedConfig.sections as section}
                                    <span class={'sa-new-nota-modal-tag'}>{section.id}</span>
                                {/each}
                            </div>
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <div class={'sa-new-nota-modal-modal-footer'}>
            <button class="sa-btn sa-btn-secondary" on:click={handleCancel}>Annuleren</button>
            <button class="sa-btn sa-btn-primary" disabled={!selectedConfigId} on:click={handleStart}>
                Selecteer & Start <i class="ph-bold ph-arrow-right" aria-hidden="true"></i>
            </button>
        </div>
    </div>
</div>
