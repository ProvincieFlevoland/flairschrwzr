<script>
    import './DeleteConfigModal.css';
    import { dialogFocus } from '../utils/dialogFocus.js';

    /** Modal: secure deletion of an item. User must type the name/title to confirm. */
    export let itemName = "";
    export let itemType = "configuratie"; // e.g. "configuratie", "nota"
    export let onConfirm = () => {};
    export let onCancel = () => {};

    let typedName = "";

    $: isConfirmed = typedName === itemName;

    function handleConfirm() {
        if (isConfirmed) {
            onConfirm();
        }
    }

    function handleKeyDown(event) {
        if (event.key === 'Enter' && isConfirmed) {
            handleConfirm();
        }
    }
</script>

<div class={'sa-delete-config-modal-modal-backdrop'} on:click|self={onCancel} role="presentation">
    <div class="{'sa-delete-config-modal-modal-content'} {'sa-delete-config-modal-danger'}" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title" use:dialogFocus={{ onClose: onCancel }}>
        <div class={'sa-delete-config-modal-modal-header'}>
            <h2 id="delete-modal-title">{itemType.charAt(0).toUpperCase() + itemType.slice(1)} verwijderen</h2>
            <button class={'sa-delete-config-modal-btn-close'} on:click={onCancel} aria-label="Sluiten"><i class="ph ph-x" aria-hidden="true"></i></button>
        </div>

        <div class={'sa-delete-config-modal-modal-body'}>
            <div class="{'sa-delete-config-modal-alert-box'} {'sa-delete-config-modal-danger'}">
                <i class="ph-bold ph-warning" aria-hidden="true"></i>
                <div class={'sa-delete-config-modal-alert-message'}>
                    <strong>Let op:</strong> Dit zal de {itemType} <strong>"{itemName}"</strong> permanent verwijderen. Deze actie kan niet ongedaan worden gemaakt.
                </div>
            </div>

            <p class={'sa-delete-config-modal-instruction'}>
                Weet je zeker dat je de {itemType} wilt verwijderen? Type de naam van de {itemType} om hem te verwijderen:
            </p>

            <div class={'sa-delete-config-modal-confirm-input-group'}>
                <input
                    type="text"
                    bind:value={typedName}
                    placeholder="Typ hier de naam..."
                    class={'sa-delete-config-modal-form-input'}
                    on:keydown={handleKeyDown}
                    autofocus
                />
                <p class={'sa-delete-config-modal-input-hint'}>Type exact: <code class={'sa-delete-config-modal-name-confirm'}>{itemName}</code></p>
            </div>
        </div>

        <div class={'sa-delete-config-modal-modal-footer'}>
            <button class="{'sa-delete-config-modal-btn'} {'sa-delete-config-modal-btn-secondary'}" on:click={onCancel}>Annuleren</button>
            <button
                class="{'sa-delete-config-modal-btn'} {'sa-delete-config-modal-btn-danger-solid'}"
                disabled={!isConfirmed}
                on:click={handleConfirm}
            >
                <i class="ph-bold ph-trash" aria-hidden="true"></i>
                Verwijderen
            </button>
        </div>
    </div>
</div>
