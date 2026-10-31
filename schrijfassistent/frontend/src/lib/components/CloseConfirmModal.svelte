<script>
    /**
     * Asked when the user closes the Schrijfassistent while a save
     * is pending or in flight. Styled like the typed-confirmation modal (DeleteConfigModal.css); no typing is
     * required because nothing is destroyed: on confirm App.svelte runs the immediate autosave first.
     */
    import './DeleteConfigModal.css';
    import { dialogFocus } from '../utils/dialogFocus.js';

    export let onConfirm = () => {};
    export let onCancel = () => {};
    export let status = 'pending'; // 'pending' | 'saving' | 'unsaved' | 'conflict' (closeSequence.js closeConfirmationKind)
    /** `close`: the Schrijfassistent closes; `back`: the editor is left for the overview (App.svelte handleBackFromEditor). */
    export let action = 'close';
    $: back = action === 'back';
    /** Close without saving (kinds `unsaved` and `conflict`). */
    export let onDiscard = () => {};
    /** Copies the plain text of the refused version (kind `conflict`). */
    export let onCopy = async () => {};
</script>

<div class="sa-delete-config-modal-modal-backdrop" on:click|self={onCancel} role="presentation">
    <div class="sa-delete-config-modal-modal-content" role="dialog" aria-modal="true" aria-labelledby="close-modal-title" use:dialogFocus={{ onClose: onCancel }}>
        <div class="sa-delete-config-modal-modal-header">
            <h2 id="close-modal-title">{back ? 'Terug naar overzicht' : 'Schrijfassistent sluiten'}</h2>
            <button class="sa-delete-config-modal-btn-close" on:click={onCancel} aria-label="Sluiten"><i class="ph ph-x" aria-hidden="true"></i></button>
        </div>

        <div class="sa-delete-config-modal-modal-body">
            <div class="sa-delete-config-modal-alert-box">
                <i class="ph-bold ph-cloud-arrow-up" aria-hidden="true"></i>
                <div class="sa-delete-config-modal-alert-message">
                    {#if status === 'conflict'}
                        <strong>Opslaan is gestopt.</strong> De nota is intussen door iemand anders opgeslagen; jouw laatste wijzigingen staan niet in de cloud.
                    {:else if status === 'unsaved'}
                        <strong>Automatisch opslaan staat uit.</strong> Er staan wijzigingen die nog niet naar de cloud zijn gesynchroniseerd.
                    {:else if status === 'saving'}
                        <strong>Opslaan is bezig.</strong> De nota wordt op dit moment naar de cloud gesynchroniseerd.
                    {:else}
                        <strong>Er staan wijzigingen klaar.</strong> De nota is nog niet naar de cloud gesynchroniseerd.
                    {/if}
                </div>
            </div>
            <p class="sa-delete-config-modal-instruction">
                {#if status === 'conflict'}
                    Kopieer eerst je versie. Bij sluiten gaat die versie verloren.
                {:else if status === 'unsaved'}
                    Kies of de nota eerst wordt opgeslagen of dat de wijzigingen vervallen.
                {:else if back}
                    Bij teruggaan wordt de nota eerst opgeslagen. Daarna opent het overzicht.
                {:else}
                    Bij sluiten wordt de nota eerst opgeslagen. Daarna sluit de Schrijfassistent.
                {/if}
            </p>
        </div>

        <div class="sa-delete-config-modal-modal-footer">
            <button class="sa-delete-config-modal-btn sa-delete-config-modal-btn-secondary" on:click={onCancel}>Annuleren</button>
            {#if status === 'conflict'}
                <button class="sa-delete-config-modal-btn sa-delete-config-modal-btn-secondary" data-testid="close-copy" on:click={onCopy}>Kopieer mijn versie</button>
                <button class="sa-delete-config-modal-btn sa-delete-config-modal-btn-danger-solid" data-testid="close-discard" on:click={onDiscard}>
                    <i class="ph-bold ph-sign-out" aria-hidden="true"></i>
                    Sluiten zonder opslaan
                </button>
            {:else}
                {#if status === 'unsaved'}
                    <button class="sa-delete-config-modal-btn sa-delete-config-modal-btn-secondary" data-testid="close-discard" on:click={onDiscard}>{back ? 'Terug zonder opslaan' : 'Sluiten zonder opslaan'}</button>
                {/if}
                <button class="sa-delete-config-modal-btn sa-delete-config-modal-btn-danger-solid" data-testid="close-confirm" on:click={onConfirm}>
                    <i class="ph-bold {back ? 'ph-arrow-left' : 'ph-sign-out'}" aria-hidden="true"></i>
                    {back ? 'Opslaan en terug' : 'Opslaan en sluiten'}
                </button>
            {/if}
        </div>
    </div>
</div>
