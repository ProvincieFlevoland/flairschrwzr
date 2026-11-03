<script>
    /** Floating UI on text selection (reviewer): pick type → type note → submit. */
    import { onMount } from 'svelte';
    export let bubble;
    export const currentUser = null;

    export let onupdateBubble = (detail) => {};
    export let onsubmitNote = (detail) => {};
    export let ondismiss = () => {};

    let textareaRef;
    let inputText = '';

    const NOTE_TYPES = [
        { label: 'Opmerking', icon: 'ph-chat-text', color: '#3b82f6' },
        { label: 'Correctie', icon: 'ph-pencil-simple', color: '#ef4444' },
        { label: 'Vraag', icon: 'ph-question', color: '#f59e0b' },
    ];

    $: if (bubble.step === 'input' && textareaRef) {
        textareaRef.focus();
    }

    function handleTypeSelect(type) {
        onupdateBubble({ ...bubble, step: 'input', noteType: type });
        inputText = '';
    }

    /** Sends `{ text, type }` to parent when input is non-empty. */
    function handleSubmit() {
        if (!inputText.trim()) return;
        onsubmitNote({ text: inputText, type: bubble.noteType });
    }

    /** Escape closes the bubble. */
    function onKeyDown(e) {
        if (e.key === 'Escape') ondismiss();
    }

    $: typeInfo = NOTE_TYPES.find(t => t.label === bubble.noteType);
    $: style = `position: fixed; left: ${bubble.x}px; top: ${bubble.y}px; transform: translate(-50%, -100%); z-index: 9999;`;
</script>

<svelte:window on:keydown={onKeyDown} />

<div class="selection-bubble" {style}>
    <div class="selection-bubble-arrow"></div>
    {#if bubble.step === 'type'}
        <div class="bubble-type-row">
            {#each NOTE_TYPES as { label, icon, color }}
                <button
                    class="bubble-type-btn"
                    style="--sa-bubble-color: {color}"
                    on:click={() => handleTypeSelect(label)}
                >
                    <i class="ph-bold {icon}" aria-hidden="true"></i>
                    {label}
                </button>
            {/each}
        </div>
    {:else if bubble.step === 'input'}
        <div class="bubble-input-area">
            <div class="bubble-input-header">
                <span class="bubble-type-tag" style="background-color: {typeInfo?.color}20; color: {typeInfo?.color}; border: 1px solid {typeInfo?.color}40">
                    <i class="ph-bold {typeInfo?.icon}" aria-hidden="true"></i> {bubble.noteType}
                </span>
                <button class="bubble-close-btn" on:click={ondismiss} title="Annuleren">
                    <i class="ph-bold ph-x" aria-hidden="true"></i>
                </button>
            </div>
            <textarea
                bind:this={textareaRef}
                class="bubble-textarea"
                placeholder="Typ uw feedback..."
                bind:value={inputText}
                on:keydown={(e) => {
                    if (e.key === 'Enter' && e.ctrlKey) {
                        e.preventDefault();
                        handleSubmit();
                    }
                }}
                rows="3"
            ></textarea>
            <div class="bubble-footer">
                <span class="bubble-hint">Ctrl+Enter</span>
                <button class="bubble-ok-btn" on:click={handleSubmit} disabled={!inputText.trim()}>
                    <i class="ph-bold ph-check" aria-hidden="true"></i> OK
                </button>
            </div>
        </div>
    {/if}
</div>
