<script>
    /** Reviewer sidebar: note list, jump to highlight, delete own notes. */
    export let nota;
    export let currentUser;

    export let onjumpToNote = (id) => {};
    export let onremoveNote = (id) => {};

    let activeNoteId = null;

    /** Deterministic colour per reviewer name (consistent with Workspace). */
    function getReviewerColor(name) {
        const REVIEWER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const index = Math.abs(hash) % REVIEWER_COLORS.length;
        return REVIEWER_COLORS[index];
    }

    /** Marks active note in list and notifies parent (scroll/highlight in editor). */
    function jumpToNote(noteId) {
        activeNoteId = noteId;
        onjumpToNote(noteId);
    }

    /** Removes note via workspace callback. */
    function removeNote(noteId) {
        onremoveNote(noteId);
    }
</script>

<section class="right-pane-section">
    <div class="pane-header">
        <h2 class="pane-title"><i class="ph-bold ph-chat-text"></i> Notities & Feedback</h2>
        <span class="stats-badge">{(nota && nota.notes && nota.notes.length) || 0}</span>
    </div>

    <div style="padding: 12px 16px; border-bottom: 1px solid var(--sa-border-color); background-color: var(--sa-bg-panel)">
        <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--sa-primary-text); font-style: italic">
            <i class="ph-bold ph-cursor-text" style="font-size: 1rem"></i>
            Selecteer tekst in het document om een notitie toe te voegen.
        </div>
    </div>

    <div class="pane-list">
        {#if !nota || !nota.notes || nota.notes.length === 0}
            <p style="color: var(--sa-text-muted); text-align: center; margin-top: 24px">Nog geen notities voor dit document.</p>
        {:else}
            {#each nota.notes as note (note.id || note.timestamp)}
                {@const rColor = getReviewerColor(note.reviewerName)}
                <div 
                    class="review-checklist-card {activeNoteId === note.id ? 'active' : ''}" 
                    style="border-left: 4px solid {rColor}; cursor: {note.id ? 'pointer' : 'default'}"
                    on:click={() => note.id && jumpToNote(note.id)}
                    role="button"
                    tabindex="0"
                    on:keydown={(e) => e.key === 'Enter' && note.id && jumpToNote(note.id)}
                >
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid var(--sa-bg-main); padding-bottom: 8px">
                        <div style="display: flex; align-items: center; gap: 8px">
                            <div style="width: 24px; height: 24px; border-radius: 50%; background-color: {rColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: bold">
                                {note.reviewerName.charAt(0)}
                            </div>
                            <strong style="font-size: 0.85rem">{note.reviewerName}</strong>
                        </div>
                        <span style="font-size: 0.75rem; color: var(--sa-text-muted)">
                            {new Date(note.timestamp).toLocaleDateString('nl-NL')}
                        </span>
                    </div>
                    <div style="margin-bottom: 8px">
                        <span style="font-size: 0.7rem; font-weight: bold; text-transform: uppercase; color: {rColor}; background-color: {rColor}15; padding: 2px 6px; border-radius: 4px">
                            {note.type || 'Opmerking'}
                        </span>
                    </div>
                    <p style="font-size: 0.875rem; color: var(--sa-text-main); margin: 0; white-space: pre-wrap">{note.text}</p>

                    {#if note.reviewerName === currentUser.name}
                        <div style="margin-top: 12px">
                            <button class="sa-btn sa-btn-danger" style="font-size: 0.75rem; padding: 4px 8px" on:click|stopPropagation={() => removeNote(note.id)} title="Verwijder notitie">
                                <i class="ph-bold ph-trash"></i> Verwijder
                            </button>
                        </div>
                    {/if}
                </div>
            {/each}
        {/if}
    </div>
</section>
