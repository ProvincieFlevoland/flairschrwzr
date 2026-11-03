<script>
    /**
     * One chapter/block in the nota: rich body, H2 header, suggestion highlights, paste sanitisation,
     * workflow lock (no edit when “done”) and expandable full-screen mode.
     */
    import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
    import './BlockEditor.css';
    import { clipboardToMinimalFragment } from '$lib/utils/pasteSanitize.js';
    import { setNotaHtml } from '$lib/utils/safetyFilter.js';
    import { activeSuggestion as activeSuggestionStore, hoveredSuggestion as hoveredSuggestionStore } from '$lib/suggestionStore.js';
    const dispatch = createEventDispatcher();

    export let block;
    /** When true, show auto-AI countdown bar (only in AI workflow phase; controlled by parent). */
    export let showAgentPending = false;
    export const idx = null;
    export let isReadOnly = false;
    export let isFocused = false;
    export let isExpanded = false;

    export let workflowReadOnly = false;

    export let isAnalyzing = false;
    /** Wall-clock ms when automatic AI analysis is scheduled (null if none). */
    export let agentPendingUntil = null;
    /** Same duration as Workspace `AUTO_AI_DELAY_MS` (for progress). */
    export let agentPendingTotalMs = 10000;
    export let highlights = [];
    /** When non-empty, words NOT in this list are shown in red (active on B1 tab). */
    export let b1WordList = [];

    /** (bodyHtml, optionalHeaderHtml) — pass header when a suggestion changed the chapter H2. */
    export let onupdate = (bodyHtml, optionalHeaderHtml) => {};
    export let onfocus = () => {};
    /** Restarts auto-AI countdown in parent when user clicks the cell (only if a pending timer already exists). */
    export let onBumpAutoAiDelay = () => {};
    export let ontoggleExpand = () => {};
    export let ontriggerAi = () => {};

    let editorRef;
    /** Full block (header + body) so structuur matches chapter titles in the H2, not only body. */
    let blockHighlightRoot;

    /** Track if there are structuur suggestions for this block */
    $: hasStructuurHighlights = highlights && highlights.some(h => h.source === 'structuur');
    $: structuurHighlightIds = hasStructuurHighlights
        ? highlights.filter(h => h.source === 'structuur').map(h => h.id).join(' ')
        : '';

    /** Low-profile countdown until auto agent run; updated on a short interval while pending. */
    let nowTick = typeof Date !== 'undefined' ? Date.now() : 0;
    let pendingPollId = null;

    /** Stops the interval that refreshes the auto-AI countdown UI. */
    function stopPendingPoll() {
        if (pendingPollId != null) {
            clearInterval(pendingPollId);
            pendingPollId = null;
        }
    }

    $: agentPendingProgress =
        agentPendingUntil != null && agentPendingTotalMs > 0
            ? Math.max(0, Math.min(1, (agentPendingUntil - nowTick) / agentPendingTotalMs))
            : 0;

    $: agentPendingVisible =
        showAgentPending &&
        agentPendingUntil != null &&
        nowTick < agentPendingUntil &&
        agentPendingProgress > 0.008;

    $: if (agentPendingUntil != null && agentPendingUntil > Date.now()) {
        if (pendingPollId == null && typeof window !== 'undefined') {
            nowTick = Date.now();
            pendingPollId = setInterval(() => {
                nowTick = Date.now();
                if (agentPendingUntil != null && nowTick >= agentPendingUntil) {
                    stopPendingPoll();
                }
            }, 180);
        }
    } else {
        stopPendingPoll();
    }

    onDestroy(stopPendingPoll);

    // 1) When not editing, overwrite editor from parent first (e.g. after accept / reload).
    // Treat focus anywhere inside the contenteditable as "editing" — some browsers focus an inner node,
    // not the host; syncing with stale `block` could wipe a keystroke and leave parent `content` behind.
    $: if (editorRef && block) {
        if (typeof document !== 'undefined') {
            const ae = document.activeElement;
            const editingHere = ae && (ae === editorRef || editorRef.contains(ae));
            if (!editingHere && editorRef.innerHTML !== block.content) {
                // SAFETY: the string is filtered again on its way into the DOM (idempotent), whatever produced
                // `block.content` (no code path turns text into HTML without a filter pass on the final string).
                // Cost: one parse per differing write; the check above keeps it off the typing path.
                setNotaHtml(editorRef, block.content);
            }
        }
    }

    // 2) Paint highlights after flush so we never reset innerHTML after spans were added.
    // While the user types, `Workspace` rebuilds `highlights` every keystroke (new array refs) — re-running
    // applyHighlight would mutate the contenteditable DOM and reset the caret (text appears "backwards").
    $: if (editorRef && highlights) {
        const _w = b1WordList; // track b1WordList changes too
        tick().then(() => {
            if (editorRef) applyHighlight({ respectFocus: true });
        });
    }

    // 3) Apply hover highlight when hovering over sidebar suggestion
    $: if (blockHighlightRoot && $hoveredSuggestionStore) {
        const allHighlights = blockHighlightRoot.querySelectorAll('.suggestion-highlight');
        allHighlights.forEach(el => {
            if (el.dataset.id === $hoveredSuggestionStore.id) {
                el.classList.add('hovered-from-sidebar');
            } else {
                el.classList.remove('hovered-from-sidebar');
            }
        });
    } else if (blockHighlightRoot) {
        // Clear all hover highlights when nothing is hovered
        const allHighlights = blockHighlightRoot.querySelectorAll('.suggestion-highlight');
        allHighlights.forEach(el => el.classList.remove('hovered-from-sidebar'));
    }

    // 4) Scroll to active highlight in editor when suggestion is clicked in tab
    $: if (blockHighlightRoot && $activeSuggestionStore?.highlightId && $activeSuggestionStore?.blockId === `block-${block.id}`) {
        tick().then(() => {
            const highlight = blockHighlightRoot.querySelector(`[data-id="${$activeSuggestionStore.highlightId}"]`);
            if (highlight) {
                highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    // 5) Scroll to hovered highlight when hovering over tab suggestion
    $: if (blockHighlightRoot && $hoveredSuggestionStore?.source === 'tab') {
        tick().then(() => {
            const highlight = blockHighlightRoot.querySelector(`[data-id="${$hoveredSuggestionStore.id}"]`);
            if (highlight) {
                highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    /** Click on `.suggestion-highlight`: dispatches `highlightClick` to parent (open modal). */
    function handleHighlightClick(e) {
        if (workflowReadOnly) return;
        const el = e.target.closest?.('.suggestion-highlight');
        if (el?.dataset?.id) {
            dispatch('highlightClick', { id: el.dataset.id, blockId: block.id });
        }
    }

    /** Escape string for use in `new RegExp`. */
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Normalises suggestion fragments for DOM search/replace: decodes `&nbsp;` in plain strings,
     * parses optional HTML to text when needed, preserves leading/trailing spaces (no trim).
     */
    function suggestionTextForDomSearch(raw) {
        if (raw == null) return '';
        let s = String(raw)
            .replace(/&nbsp;/gi, ' ')
            .replace(/&#0*160;/gi, ' ')
            .replace(/&#x0*A0;/gi, ' ')
            .replace(/\u00a0/g, ' ');
        if (/<[a-z][\s\S]*>/i.test(s)) {
            if (typeof document === 'undefined') {
                return s.replace(/<[^>]*>/g, ' ');
            }
            const tmp = document.createElement('div');
            // SAFETY: `s` is AI text that may contain markup; a detached div in the live document still fires
            // `<img onerror>`, so the text goes through the safety filter first (the text of a clean fragment is unchanged).
            setNotaHtml(tmp, s);
            s = (tmp.textContent || tmp.innerText || '').replace(/\u00a0/g, ' ');
        }
        return s;
    }

    /** Root for highlight DOM: full cell (header + body) or editor only. */
    // Known behaviour: highlight and replace scan the WHOLE cell (header + body) for the first occurrence; the header's
    // inter-element whitespace already holds two or three spaces, so a double-space row lands in the header and the body never changes.
    function highlightScanRoot() {
        return blockHighlightRoot || editorRef;
    }

    /**
     * Removes old spans and applies `highlights` as clickable spans (structure → b1 → spelling).
     * @param {{ respectFocus?: boolean }} [opts] - If `respectFocus` is true (default), do not mutate
     *   while the caret is in this editor — avoids caret reset on every keystroke.
     */
    function applyHighlight(opts = {}) {
        const respectFocus = opts.respectFocus !== false;
        const root = highlightScanRoot();
        if (!root) return;

        if (respectFocus && editorRef && typeof document !== 'undefined') {
            const ae = document.activeElement;
            if (ae && (ae === editorRef || editorRef.contains(ae))) {
                return;
            }
        }

        // 1. Remove all existing highlights surgically (header + body)
        root.querySelectorAll('.suggestion-highlight, .non-b1-word').forEach(el => {
            el.replaceWith(document.createTextNode(el.textContent));
        });
        // Known behaviour: `normalize()` on the whole cell (header + body) drops the empty text nodes Svelte 5 uses as anchors,
        // so after one highlight pass the "Afgerond" pill is never rendered and the AI button label goes stale.
        root.normalize();

        if (!highlights || highlights.length === 0) {
            applyWordListHighlight(root);
            return;
        }

        const struct = highlights
            .filter(h => h.source === 'structuur')
            .sort((a, b) => b.original.length - a.original.length);
        const b1 = highlights
            .filter(h => h.source === 'b1')
            .sort((a, b) => a.original.length - b.original.length);
        const spelling = highlights
            .filter(h => h.source === 'spelling')
            .sort((a, b) => a.original.length - b.original.length);
        const woordenlijst = highlights
            .filter(h => h.source === 'woordenlijst')
            .sort((a, b) => a.original.length - b.original.length);

        // For structuur: add visual indicator without wrapping content
        // We'll add a CSS class to the cell container instead (handled separately)

        // B1 and spelling: match specific text fragments
        const textMatchHighlights = [...b1, ...spelling, ...woordenlijst];
        textMatchHighlights.forEach(hl => {
            const cleanTarget = suggestionTextForDomSearch(hl.original);
            if (!cleanTarget) return;

            const range = findTextRange(root, cleanTarget);
            if (range) {
                const span = document.createElement('span');
                span.className = `suggestion-highlight source-${hl.source}`;
                span.dataset.id = hl.id;
                try {
                    range.surroundContents(span);
                } catch (e) {
                    const content = range.extractContents();
                    span.appendChild(content);
                    range.insertNode(span);
                }
            }
        });

        applyWordListHighlight(root);
    }

    /**
     * Walks text nodes (skipping those inside .suggestion-highlight spans) and wraps
     * words NOT in `b1WordList` with a .non-b1-word span (shown in red).
     * @param {HTMLElement} root
     */
    function applyWordListHighlight(root) {
        if (!b1WordList || b1WordList.length === 0) return;

        const wordSet = new Set(b1WordList.map(w => w.toLowerCase()));
        const wordRe = /[a-zA-ZÀ-ÿ\u0100-\u017E]+(?:[''][a-zA-ZÀ-ÿ\u0100-\u017E]+)*/g;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) =>
                node.parentElement?.closest('.suggestion-highlight')
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT
        });

        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        for (const textNode of textNodes) {
            const text = textNode.textContent;
            wordRe.lastIndex = 0;
            let match;
            let lastIndex = 0;
            let hasNonB1 = false;

            // quick check: is there any non-B1 word in this node?
            while ((match = wordRe.exec(text)) !== null) {
                if (!wordSet.has(match[0].toLowerCase())) { hasNonB1 = true; break; }
            }
            if (!hasNonB1) continue;

            wordRe.lastIndex = 0;
            const frag = document.createDocumentFragment();
            while ((match = wordRe.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                }
                const word = match[0];
                if (wordSet.has(word.toLowerCase())) {
                    frag.appendChild(document.createTextNode(word));
                } else {
                    const span = document.createElement('span');
                    span.className = 'non-b1-word';
                    span.textContent = word;
                    frag.appendChild(span);
                }
                lastIndex = match.index + word.length;
            }
            if (lastIndex < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            }
            textNode.replaceWith(frag);
        }
    }

    /**
     * Finds plain `targetText` in text nodes under `root` and returns a `Range`.
     * @param {HTMLElement} root
     * @param {string} targetText
     * @returns {Range|null}
     */
    function findTextRange(root, targetText) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        let node;
        let fullText = "";

        while (node = walker.nextNode()) {
            nodes.push({
                node,
                start: fullText.length,
                end: fullText.length + node.textContent.length
            });
            fullText += node.textContent;
        }

        // Normalize both strings for comparison (esp. non-breaking spaces)
        const normalizedFullText = fullText.replace(/\u00a0/g, ' ').toLowerCase();
        const normalizedTarget = targetText.replace(/\u00a0/g, ' ').toLowerCase();

        const index = normalizedFullText.indexOf(normalizedTarget);
        if (index === -1) return null;

        const range = document.createRange();
        const endIndex = index + targetText.length;
        let startNodeInfo;
        let endNodeInfo;
        for (const info of nodes) {
            if (index >= info.start && index < info.end) startNodeInfo = info;
            if (endIndex > info.start && endIndex <= info.end) endNodeInfo = info;
        }

        if (startNodeInfo && endNodeInfo) {
            range.setStart(startNodeInfo.node, index - startNodeInfo.start);
            range.setEnd(endNodeInfo.node, (index + targetText.length) - endNodeInfo.start);
            return range;
        }
        return null;
    }

    /**
     * Replaces one text fragment (e.g. after accepting a suggestion or performing a targeted undo).
     * Returns `true` when the text was found and replaced, `false` when `oldText` could not be located
     * in the current editor content (e.g. subsequent manual edit removed it).
     * @param {string} oldText
     * @param {string} newText
     * @returns {boolean}
     */
    export function replaceText(oldText, newText) {
        if (!editorRef || workflowReadOnly) return false;
        const root = highlightScanRoot();

        // Remove highlights first so they don't interfere with text search
        const existing = root.querySelectorAll('.suggestion-highlight');
        existing.forEach(el => {
            const text = el.textContent;
            el.replaceWith(document.createTextNode(text));
        });

        // Sanitize input
        const cleanOldText = suggestionTextForDomSearch(oldText);
        const cleanNewText = suggestionTextForDomSearch(newText);

        // Find the range and replace it (title may live in header; body in cell-content)
        const range = findTextRange(root, cleanOldText);
        if (range) {
            const anchor = range.startContainer;
            const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
            const changeInBody = editorRef.contains(anchorEl);

            range.deleteContents();
            range.insertNode(document.createTextNode(cleanNewText));

            const h2 = blockHighlightRoot?.querySelector('h2.dynamic-chapter');
            const newHeader = h2?.outerHTML;
            if (changeInBody) {
                onupdate(editorRef.innerHTML);
            } else if (newHeader) {
                onupdate(editorRef.innerHTML, newHeader);
            } else {
                onupdate(editorRef.innerHTML);
            }
            return true;
        }
        return false;
    }

    /**
     * Replaces the entire editor content (used for structuur suggestions).
     * @param {string} newContent
     */
    export function setContent(newContent) {
        if (!editorRef || workflowReadOnly) return;

        // If newContent is plain text without HTML tags, wrap it in a paragraph
        const hasHtmlTags = /<[^>]+>/.test(newContent);
        const formattedContent = hasHtmlTags
            ? newContent
            : `<p>${newContent.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;

        // SAFETY: `newContent` is the AI answer of a structuur accept; it enters the editor through the safety filter.
        setNotaHtml(editorRef, formattedContent);
        onupdate(editorRef.innerHTML);
    }

    onMount(() => {
        if (editorRef) {
            // SAFETY: through the filter, see the reactive block 1 above.
            setNotaHtml(editorRef, block.content);
        }
    });

    /** Syncs body to parent on every input (unless workflow is read-only). */
    function handleInput(e) {
        if (workflowReadOnly) return;
        onupdate(e.target.innerHTML);
    }

    /** Paste: no foreign markup — only text, line breaks (`<br>`), bold and italic. */
    function handlePaste(e) {
        if (isReadOnly || isAnalyzing || workflowReadOnly || !editorRef) return;
        e.preventDefault();

        const html = e.clipboardData?.getData('text/html') ?? '';
        const plain = e.clipboardData?.getData('text/plain') ?? '';
        const fragment = clipboardToMinimalFragment(html, plain);
        if (!fragment.childNodes.length) return;

        const last = fragment.lastChild;
        const sel = window.getSelection();
        if (!sel) return;

        let /** @type {Range | null} */ range = null;
        if (sel.rangeCount > 0) {
            const r = sel.getRangeAt(0);
            const anchor = r.commonAncestorContainer;
            const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
            if (anchorEl && editorRef.contains(anchorEl)) range = r;
        }

        if (!range) {
            range = document.createRange();
            range.selectNodeContents(editorRef);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }

        range.deleteContents();
        range.insertNode(fragment);

        if (last && last.parentNode) {
            range.setStartAfter(last);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }

        onupdate(editorRef.innerHTML);
    }

    // Drag and drop: Chromium inserts the HTML of a dropped selection into a contenteditable by itself,
    // which bypasses the paste rule (images, links, tables and CSS backgrounds landed in the nota). Text dragged within this
    // cell is its own content and moves as before; anything from outside is reduced exactly like a paste.
    let dragFromEditor = false;

    function handleDragStart() {
        dragFromEditor = true;
    }

    function handleDragEnd() {
        dragFromEditor = false;
    }

    function handleDragOver(e) {
        if (dragFromEditor) return;
        e.preventDefault();
    }

    /** @param {DragEvent} e */
    function handleDrop(e) {
        if (dragFromEditor) {
            dragFromEditor = false;
            return;
        }
        e.preventDefault();
        if (isReadOnly || isAnalyzing || workflowReadOnly || !editorRef) return;

        const html = e.dataTransfer?.getData('text/html') ?? '';
        const plain = e.dataTransfer?.getData('text/plain') ?? '';
        const fragment = clipboardToMinimalFragment(html, plain);
        if (!fragment.childNodes.length) return;

        /** @type {Range | null} */
        let range = null;
        if (typeof document.caretPositionFromPoint === 'function') {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        } else if (typeof document.caretRangeFromPoint === 'function') {
            range = document.caretRangeFromPoint(e.clientX, e.clientY);
        }
        if (!range || !editorRef.contains(range.startContainer)) {
            range = document.createRange();
            range.selectNodeContents(editorRef);
        }
        range.collapse(false);

        const last = fragment.lastChild;
        range.insertNode(fragment);
        const sel = window.getSelection();
        if (sel && last && last.parentNode) {
            range.setStartAfter(last);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        onupdate(editorRef.innerHTML);
    }

    /** On blur, redraw highlights (skipped during focus to preserve caret). */
    function handleEditorBlur() {
        tick().then(() => {
            if (editorRef) applyHighlight({ respectFocus: false });
        });
    }

    /** Marks this block as active in the workspace. */
    function handleFocus() {
        onfocus();
    }

    /**
     * Cell mousedown: active block + optionally restart auto-AI countdown
     * (same as while typing when a pending countdown already exists).
     */
    function handleCellMousedown(e) {
        if (e?.target?.closest?.('button, a, [role="button"]')) {
            handleFocus();
            return;
        }
        handleFocus();
        if (!isReadOnly && !isAnalyzing && !workflowReadOnly) {
            onBumpAutoAiDelay();
        }
    }

    /** Click on content wrapper: same as above. */
    function handleWrapperClick() {
        handleFocus();
    }

    /** Editor gains focus: notify parent (active block). */
    function handleEditorFocus() {
        handleFocus();
    }

    /** Toggle full-screen writing mode. */
    function toggleExpand() {
        ontoggleExpand();
    }

    /** Copies plain text of the block to the clipboard. */
    function copyText() {
        navigator.clipboard.writeText(editorRef.innerText);
    }
</script>

<div
    class="editor-cell {isFocused ? 'focused' : ''} {isExpanded ? 'expanded' : ''} {isAnalyzing ? 'sa-block-editor-analyzing' : ''}"
    data-block-id={block.id}
    bind:this={blockHighlightRoot}
    on:mousedown={(e) => {
        const clickedHighlight = e.target.closest?.('.suggestion-highlight');
        const clickedOnCell = e.target.closest?.('.cell-content, .cell-content-wrapper');

        if (clickedHighlight) {
            // Clicking a B1/spelling highlight - open modal immediately
            handleFocus();
            handleHighlightClick(e);
        } else if (clickedOnCell && hasStructuurHighlights && !workflowReadOnly) {
            // Clicking anywhere in a cell with structuur highlights - open first structuur suggestion
            handleFocus();
            const firstStructuur = highlights.find(h => h.source === 'structuur');
            if (firstStructuur) {
                dispatch('highlightClick', { id: firstStructuur.id, blockId: block.id });
            }
        } else {
            // Clicking elsewhere - close modal and handle normal mousedown
            activeSuggestionStore.set(null);
            handleCellMousedown(e);
        }
    }}
    on:mouseover={(e) => {
        const highlight = e.target.closest?.('.suggestion-highlight');
        if (highlight?.dataset?.id) {
            hoveredSuggestionStore.set({ id: highlight.dataset.id, source: 'text' });
        }
    }}
    on:mouseout={(e) => {
        const highlight = e.target.closest?.('.suggestion-highlight');
        if (highlight?.dataset?.id) {
            // Only clear if we're actually leaving this specific highlight
            const relatedTarget = e.relatedTarget;
            if (!relatedTarget || !relatedTarget.closest || !relatedTarget.closest('.suggestion-highlight')) {
                hoveredSuggestionStore.set(null);
            }
        }
    }}
    role="none"
>
    <div class="cell-header {block.chapterId ? '' : 'metadata-header'}">
        <div class="header-info" style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <h2 class="dynamic-chapter" data-chapter-id={block.chapterId}>{block.title}</h2>
            {#if workflowReadOnly}
                <span class={'sa-block-editor-wf-done-pill'} title="Dit hoofdstuk is afgerond en vergrendeld">
                    <i class="ph ph-lock-simple ph-bold" aria-hidden="true"></i> Afgerond
                </span>
            {/if}
        </div>

        <div class="cell-actions">
            {#if !workflowReadOnly || isAnalyzing}
                <button
                    class="cell-ai-btn {isAnalyzing ? 'cell-ai-btn--analyzing' : ''}"
                    on:click|stopPropagation={ontriggerAi}
                    title="AI analyseren"
                    disabled={isAnalyzing}
                >
                    <i class="ph-bold {isAnalyzing ? 'ph-circle-notch ph-spin' : 'ph-sparkle'}" aria-hidden="true"></i>
                    {isAnalyzing ? 'Analyseert...' : 'AI analyse'}
                </button>
            {/if}
            <button class="cell-copy-btn" on:click|stopPropagation={copyText} title="Alleen tekst kopiëren" disabled={isAnalyzing}>
                <i class="ph ph-copy" aria-hidden="true"></i>
            </button>
            <button
                class="cell-expand-btn"
                on:click|stopPropagation={toggleExpand}
                title={isExpanded ? 'Minimaliseren' : 'Uitklappen'}
                disabled={isAnalyzing}
            >
                <i class="ph-bold {isExpanded ? 'ph-arrows-in' : 'ph-arrows-out'}" aria-hidden="true"></i>
            </button>
        </div>
    </div>

    <div class="cell-main">
        <div
            class="cell-content-wrapper {isAnalyzing ? 'sa-block-editor-locked' : ''} {workflowReadOnly ? 'sa-block-editor-workflow-readonly' : ''} {hasStructuurHighlights ? 'has-structuur-highlight' : ''}"
            data-structuur-ids={structuurHighlightIds || undefined}
            role="none"
            on:click={handleWrapperClick}
        >
            <div
                bind:this={editorRef}
                class="cell-content"
                contenteditable={!isReadOnly && !isAnalyzing && !workflowReadOnly}
                spellcheck={!isReadOnly && !isAnalyzing && !workflowReadOnly}
                lang="nl"
                on:input={handleInput}
                on:paste={handlePaste}
                on:dragstart={handleDragStart}
                on:dragend={handleDragEnd}
                on:dragover={handleDragOver}
                on:drop={handleDrop}
                on:focus={handleEditorFocus}
                on:blur={handleEditorBlur}
                role="textbox"
                aria-multiline="true"
                tabindex="0"
                data-placeholder="Start met typen..."
                data-isempty={!block.content || block.content.replace(/<[^>]*>/g, '').trim() === '' ? 'true' : undefined}
            >
            </div>
            {#if isAnalyzing}
                <div class={'sa-block-editor-editor-overlay'}></div>
            {:else if workflowReadOnly}
                <div class="{'sa-block-editor-editor-overlay'} {'sa-block-editor-editor-overlay-readonly'}" title="Blok afgerond — niet bewerkbaar"></div>
            {/if}
        </div>
    </div>

    {#if isExpanded}
        <div class="cell-footer-hint">
            <i class="ph ph-pencil"></i>
            <span>Volledig scherm modus — schrijf hier je tekst. Druk <strong>Esc</strong> om te sluiten.</span>
        </div>
    {/if}

    {#if agentPendingVisible}
        <div class={'sa-block-editor-agent-pending-track'} aria-hidden="true">
            <div
                class={'sa-block-editor-agent-pending-fill'}
                style="transform: scaleX({agentPendingProgress})"
            ></div>
        </div>
    {/if}
</div>
