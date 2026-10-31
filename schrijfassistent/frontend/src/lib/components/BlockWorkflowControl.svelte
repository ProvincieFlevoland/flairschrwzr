<script>
    /**
     * Drie compacte icoonknoppen (Concept / Review / Klaar) naast het actieve blok — geen zichtbare tekstlabels.
     */
    import './BlockWorkflowControl.css';

    /** @type {import('$lib/workflow.js').BlockWorkflowState} */
    export let state = 'concept';
    export let disabled = false;

    /** @type {(id: import('$lib/workflow.js').BlockWorkflowState) => void} */
    export let onPick = () => {};

    const options = [
        { id: /** @type {const} */ ('concept'), label: 'Concept', icon: 'ph-file-dashed' },
        { id: /** @type {const} */ ('review'), label: 'Review', icon: 'ph-users' },
        { id: /** @type {const} */ ('done'), label: 'Klaar', icon: 'ph-check' }
    ];

    /** @param {import('$lib/workflow.js').BlockWorkflowState} id */
    function pick(id) {
        if (disabled) return;
        onPick(id);
    }
</script>

<div class={'sa-block-workflow-control-wf-dots'} role="radiogroup" aria-label="Fase van dit hoofdstuk">
    {#each options as o (o.id)}
        <button
            type="button"
            role="radio"
            aria-checked={state === o.id}
            class="{'sa-block-workflow-control-wf-dot'} {`sa-block-workflow-control-wf-${o.id}`} {state === o.id ? 'sa-block-workflow-control-is-selected' : ''}"
            {disabled}
            title={o.label}
            aria-label={o.label}
            on:click={(e) => {
                e.stopPropagation();
                pick(o.id);
            }}
        >
            <i class="ph {o.icon}" aria-hidden="true"></i>
        </button>
    {/each}
</div>
