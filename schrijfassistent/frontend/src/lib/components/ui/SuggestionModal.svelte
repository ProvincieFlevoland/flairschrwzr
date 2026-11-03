<script>
    /**
     * Global modal when a suggestion is active: position near highlight, theme per source,
     * accept/dismiss, B1 alternatives, optional auto-advance, and a small shortcut set (digits, Y/N, [ ]).
     */
    import {
        activeSuggestion,
        suggestionAutoAdvance,
        setSuggestionAutoAdvance,
        suggestionNavigateNextRef,
        suggestionNavigatePrevRef
    } from '$lib/suggestionStore.js';
    import { safeLinkUrl } from '$lib/utils/safeUrl.js';
    import { decodeHtmlSpaceEntities } from '$lib/utils/blockPlainText.js';
    import { get } from 'svelte/store';
    import { fade } from 'svelte/transition';
    import { onMount, tick, getContext } from 'svelte';
    import { ROOT_EL_CONTEXT } from '$lib/hostBridge.js';
    import './SuggestionModal.css';

    /**
     * Port: cross-component lookups are rooted at the app container instead of `document`.
     * App.svelte provides the `.sa-root` element through context; without it (dev page) `document` is used.
     * @type {HTMLElement | null}
     */
    const rootEl = getContext(ROOT_EL_CONTEXT) || null;
    /** @returns {ParentNode} */
    function root() {
        return rootEl || document;
    }

    let show = false;
    let suggestion = null;
    let popupEl;
    /** Focus target for role="dialog" (must be focusable). */
    let dialogEl;
    let coords = { top: 0, left: 0 };
    /** 'above' highlight (default) or 'below' when there is no room on top */
    let popupPlacement = 'above';
    /**
     * Selected B1 rewrite when `alternatives` has multiple entries; `null` means no choice yet (required for a11y).
     * @type {number | null}
     */
    let selectedAlternativeIndex = 0;

    const VIEW_MARGIN = 14;
    const GAP = 10;
    const FALLBACK_MAX_WORDS = 20;

    /** @param {string} text */
    function summarizeToWords(text, maxWords = FALLBACK_MAX_WORDS) {
        const s = String(text ?? '').trim();
        if (!s) return '';
        const words = s.split(/\s+/).filter(Boolean);
        if (words.length <= maxWords) return words.join(' ');
        return words.slice(0, maxWords).join(' ') + '…';
    }

    /**
     * Counts B1 alternatives with non-empty `tekst` to decide if the multi-picker (no default) applies.
     * @param {any} s
     * @returns {number}
     */
    function countViableAlternatives(s) {
        if (!s) return 0;
        const raw = s.alternatives;
        if (!Array.isArray(raw) || raw.length === 0) return 0;
        return raw.filter((a) => String(a?.tekst ?? '').trim()).length;
    }

    /** Stable theme even if `source` is missing; ids are `${assignment}-${chapterId}-${blockId}-…`. */
    function resolveModalKind(s) {
        if (!s) return 'b1';
        const hid = String(s.highlightId || '');
        if (hid.startsWith('agent_structuur')) return 'structuur';
        if (hid.startsWith('agent_b1')) return 'b1';
        if (hid.startsWith('agent_woordenlijst')) return 'woordenlijst';
        if (hid.startsWith('spelling') || s.source === 'spelling') return 'spelling';
        if (s.source === 'woordenlijst') return 'woordenlijst';
        if (s.source === 'structuur') return 'structuur';
        return 'b1';
    }

    /** Removes temporary “active” styling from all highlight spans. */
    function clearActiveHighlightClass() {
        if (typeof document === 'undefined') return;
        root().querySelectorAll('.suggestion-highlight-active').forEach(el => {
            el.classList.remove('suggestion-highlight-active');
        });
    }

    activeSuggestion.subscribe(async (value) => {
        clearActiveHighlightClass();
        suggestion = value;
        const viable = countViableAlternatives(value);
        selectedAlternativeIndex = viable > 1 ? null : 0;
        show = !!value;

        if (show && typeof document !== 'undefined') {
            await tick();
            dialogEl?.focus({ preventScroll: true });
            setTimeout(() => {
                updatePosition();
                requestAnimationFrame(() => updatePosition());
            }, 50);
        }
    });

    $: modalKind = resolveModalKind(suggestion);
    $: themeColor =
        modalKind === 'structuur'
            ? 'var(--sa-structuur-text)'
            : modalKind === 'spelling'
              ? 'var(--sa-spelling-text)'
              : modalKind === 'woordenlijst'
                ? 'var(--sa-woordenlijst-text)'
                : 'var(--sa-b1-text)';
    $: themeLabel =
        modalKind === 'structuur'
            ? 'Structuur'
            : modalKind === 'spelling'
              ? 'Spelling, grammatica en leestekens'
              : modalKind === 'woordenlijst'
                ? 'Woordenlijst'
                : 'Direct Duidelijk';

    // Reposition modal when content height changes (e.g., selecting B1 alternative reveals explanation)
    $: if (show && selectedAlternativeIndex !== null && typeof requestAnimationFrame !== 'undefined') {
        tick().then(() => {
            requestAnimationFrame(() => updatePosition());
        });
    }

    /** @type {Array<{ tekst: string, uitleg: string }>} */
    $: alternativeList = (() => {
        if (!suggestion) return [];
        const raw = suggestion.alternatives;
        if (Array.isArray(raw) && raw.length > 0) {
            return raw
                .map((a) => ({
                    tekst: String(a?.tekst ?? '').trim(),
                    uitleg: String(a?.uitleg ?? '').trim()
                }))
                .filter((a) => a.tekst);
        }
        if (suggestion.suggestedText !== undefined && suggestion.suggestedText !== null) {
            return [
                {
                    tekst: String(suggestion.suggestedText),
                    uitleg: String(suggestion.explanation ?? '').trim()
                }
            ];
        }
        return [];
    })();

    $: showAlternativePicker = alternativeList.length > 1;

    $: displaySuggestedText = (() => {
        if (!suggestion) return '';
        if (showAlternativePicker) {
            if (selectedAlternativeIndex === null) return '';
            const i = selectedAlternativeIndex;
            if (i < 0 || i >= alternativeList.length) return '';
            return alternativeList[i]?.tekst ?? '';
        }
        return alternativeList[0]?.tekst ?? suggestion?.suggestedText ?? '';
    })();

    /** Same as structuur tab: when `ruleDetails` exist, rationale is per-key; do not show merged prose here. */
    $: hasStructuredRules = !!(suggestion?.ruleDetails && suggestion.ruleDetails.length > 0);
    $: displayExplanation = hasStructuredRules
        ? ''
        : showAlternativePicker && selectedAlternativeIndex !== null
          ? (alternativeList[selectedAlternativeIndex]?.uitleg || suggestion?.explanation || '')
          : showAlternativePicker
            ? ''
            : (alternativeList[0]?.uitleg || suggestion?.explanation || '');
    $: displayExplanationTrimmed = String(displayExplanation ?? '').trim();
    /** Distinct rule `key` labels (e.g. Algemeenheid, Specificiteit) for compact display. */
    $: ruleDetailKeyList = (() => {
        if (!suggestion?.ruleDetails?.length) return [];
        const seen = new Set();
        const out = [];
        for (const r of suggestion.ruleDetails) {
            const k = String(r?.key ?? '').trim();
            if (!k) continue;
            const norm = k.toLowerCase();
            if (seen.has(norm)) continue;
            seen.add(norm);
            out.push(k);
        }
        return out;
    })();
    /** Tooltip: full rule lines when we only show keys in the modal. */
    $: ruleDetailsTooltip = suggestion?.ruleDetails?.length
        ? suggestion.ruleDetails
              .map((r) => {
                  const key = String(r?.key ?? '').trim();
                  const text = String(r?.text ?? '').trim();
                  if (key && text) return `${key}: ${text}`;
                  if (text) return text;
                  return key;
              })
              .filter(Boolean)
              .join('\n')
        : '';
    /** If rules have no keys, fall back to merged prose (legacy payloads); modal shows truncated, full in `title`. */
    $: ruleDetailsFallbackProse =
        suggestion?.ruleDetails?.length && !ruleDetailKeyList.length
            ? suggestion.ruleDetails
                  .map((r) => String(r?.text ?? '').trim())
                  .filter(Boolean)
                  .join(' ')
            : '';
    $: ruleDetailsFallbackSummary = ruleDetailsFallbackProse
        ? summarizeToWords(ruleDetailsFallbackProse)
        : '';

    $: acceptEnabled =
        !!suggestion &&
        suggestion.canAccept !== false &&
        (!showAlternativePicker || selectedAlternativeIndex !== null) &&
        (showAlternativePicker ||
            (suggestion.suggestedText !== undefined && suggestion.suggestedText !== null));

    // Original text removed from modal; user sees highlighted text in document as context

    $: hasSuggestedProposal =
        showAlternativePicker ||
        !!(suggestion?.ruleDetails?.length) ||
        (suggestion != null &&
            suggestion.suggestedText !== undefined &&
            suggestion.suggestedText !== null);

    /** DOM element of the matching `.suggestion-highlight` for positioning. */
    function getAnchorEl() {
        if (typeof document === 'undefined') return null;
        const id = suggestion?.highlightId;
        if (!id) return root().querySelector('.suggestion-highlight');

        // For structuur: no highlight span exists, use the cell-content wrapper
        if (id.startsWith('agent_structuur-')) {
            const blockId = suggestion?.blockId;
            if (blockId) {
                const blockEl = root().querySelector(`[data-block-id="${blockId}"]`);
                if (blockEl) {
                    return blockEl.querySelector('.cell-content') || blockEl.querySelector('.cell-content-wrapper');
                }
            }
            return null;
        }

        // For B1/spelling: use the actual highlight span
        const el = root().querySelector(`.suggestion-highlight[data-id="${id}"]`);
        return el || root().querySelector('.suggestion-highlight');
    }

    /** Places popup by the highlight (above/below) within the viewport; sets active highlight class. */
    function updatePosition() {
        if (typeof document === 'undefined' || typeof window === 'undefined') return;
        clearActiveHighlightClass();
        const highlight = getAnchorEl();
        if (highlight) {
            // For structuur, don't add active class (no span to style)
            if (!suggestion?.highlightId?.startsWith('agent_structuur-')) {
                highlight.classList.add('suggestion-highlight-active');
            }
        }
        if (!highlight || !popupEl) return;

        // For structuur, scroll the entire cell into view
        const isStructuur = suggestion?.highlightId?.startsWith('agent_structuur-');
        if (isStructuur) {
            const cellEl = highlight.closest('.editor-cell');
            if (cellEl) {
                cellEl.scrollIntoView({ block: 'nearest', behavior: 'auto', inline: 'nearest' });
            }
        } else {
            highlight.scrollIntoView({ block: 'nearest', behavior: 'auto', inline: 'nearest' });
        }

        const rect = highlight.getBoundingClientRect();
        let popupRect = popupEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let ph = popupRect.height;
        let pw = popupRect.width;
        if (ph < 4) {
            popupRect = popupEl.getBoundingClientRect();
            ph = popupRect.height;
            pw = popupRect.width;
        }

        let top = rect.top - ph - GAP;
        popupPlacement = 'above';

        if (top < VIEW_MARGIN) {
            const belowTop = rect.bottom + GAP;
            if (belowTop + ph <= vh - VIEW_MARGIN) {
                top = belowTop;
                popupPlacement = 'below';
            } else {
                top = VIEW_MARGIN;
                popupPlacement = 'above';
            }
        }

        if (top + ph > vh - VIEW_MARGIN) {
            top = Math.max(VIEW_MARGIN, vh - ph - VIEW_MARGIN);
        }

        // For structuur: center modal horizontally on the cell
        let left;
        if (isStructuur) {
            left = rect.left + rect.width / 2 - pw / 2;
        } else {
            left = rect.left + rect.width / 2 - pw / 2;
        }
        left = Math.max(VIEW_MARGIN, Math.min(left, vw - pw - VIEW_MARGIN));

        coords = { top, left };
    }

    /** Applies chosen text via `onAccept` and clears the store. */
    function accept() {
        if (!acceptEnabled) return;
        let toApply = '';
        if (showAlternativePicker && selectedAlternativeIndex !== null) {
            toApply = String(alternativeList[selectedAlternativeIndex]?.tekst ?? '');
        } else if (suggestion?.suggestedText !== undefined && suggestion?.suggestedText !== null) {
            toApply = String(suggestion.suggestedText);
        }
        if (suggestion?.onAccept) suggestion.onAccept(toApply);
        clearActiveHighlightClass();
        activeSuggestion.set(null);
    }

    /** Calls `onDeny` (dismiss) and closes. */
    function deny() {
        if (suggestion?.onDeny) suggestion.onDeny();
        clearActiveHighlightClass();
        activeSuggestion.set(null);
    }

    /** Closes modal without changing the suggestion list (header close button; Esc since). */
    function closeOnly() {
        clearActiveHighlightClass();
        activeSuggestion.set(null);
    }

    /**
     * True if the event target is a control where letter shortcuts should not steal focus semantics.
     * @param {EventTarget|null} t
     */
    function isTypingTarget(t) {
        const el = t && /** @type {any} */ (t).nodeType === 1 ? /** @type {HTMLElement} */ (t) : null;
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return /** @type {HTMLInputElement} */ (el).type !== 'radio';
        if (el.isContentEditable) return true;
        return false;
    }

    /**
     * Opens the next / previous filtered suggestion without dismissing the current one (`]` / `[`).
     * The queue has ends: on the last row `]` and on the first row `[` do nothing, the pop-up stays where it is.
     * The workspace says whether it will open a neighbour (it opens it after its own tick); only then is this
     * pop-up closed, so a key press past the end never leaves the auteur without a pop-up.
     * @param {'next' | 'prev'} dir
     */
    function goToAdjacentInQueue(dir) {
        const ref = dir === 'next' ? suggestionNavigateNextRef : suggestionNavigatePrevRef;
        const nav = get(ref);
        const blockId = suggestion?.blockId;
        const hid = suggestion?.highlightId;
        if (typeof nav !== 'function' || !blockId || hid == null || hid === '') {
            return;
        }
        const moved = nav(String(blockId), String(hid));
        if (!moved) return;
        closeOnly();
    }

    /**
     * True if the event target is an input or contenteditable that lives outside the app container
     * (host page controls). Such events never trigger the shortcuts.
     * @param {EventTarget|null} t
     */
    function isHostTypingTarget(t) {
        if (!rootEl || !isTypingTarget(t)) return false;
        const el = /** @type {HTMLElement} */ (t);
        return !rootEl.contains(el);
    }

    /** Shortcuts: context-aware. Always Y/N, [ ]. Numeric keys (1-2) only for B1 alternatives. Esc closes the modal. */
    function handleGlobalKeydown(e) {
        if (!get(activeSuggestion)) return;
        if (isHostTypingTarget(e.target)) return;
        // "Esc only closes modals inside the app". It applies in a cell or in the modal's own checkbox too (clicking a highlight
        // leaves the caret in the cell), so it runs before the typing-target check; the suggestion list is not changed (closeOnly).
        // Esc never reaches the app container itself: the other Esc listeners are SelectionBubble's (it dismisses the bubble) and
        // Workspace's (it collapses a full-screen block, and only when no dialog is open, so this modal goes first); loader.js registers none.
        if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            closeOnly();
            return;
        }
        if (isTypingTarget(e.target)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key === ']') {
            e.preventDefault();
            goToAdjacentInQueue('next');
            return;
        }

        if (e.key === '[') {
            e.preventDefault();
            goToAdjacentInQueue('prev');
            return;
        }

        if (e.key === 'n' || e.key === 'N') {
            e.preventDefault();
            deny();
            return;
        }

        if (e.key === 'y' || e.key === 'Y') {
            if (acceptEnabled) {
                e.preventDefault();
                accept();
            }
            return;
        }

        // Numeric keys only enabled when B1 alternatives exist (limit to actual count)
        if (showAlternativePicker && /^[1-9]$/.test(e.key)) {
            const n = parseInt(e.key, 10);
            // Only allow keys for available alternatives (1-2, silently ignore others)
            if (n >= 1 && n <= alternativeList.length && n <= 2) {
                e.preventDefault();
                selectedAlternativeIndex = n - 1;
            }
        }
    }

    /**
     * @param {Event} e
     */
    function toggleAutoAdvance(e) {
        setSuggestionAutoAdvance(/** @type {HTMLInputElement} */ (e.target).checked);
    }

    // The window listeners live for the lifetime of App.svelte, which mounts this component once inside
    // `.sa-root`: registered when the app mounts, removed by the onMount cleanup on unmount.
    onMount(() => {
        if (typeof window === 'undefined') return;
        window.addEventListener('keydown', handleGlobalKeydown);
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('keydown', handleGlobalKeydown);
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    });
</script>

{#if show && suggestion}
    <div
        bind:this={popupEl}
        class="{'sa-suggestion-modal-suggestion-popup'} {popupPlacement === 'below' ? 'sa-suggestion-modal-popup-below' : ''}"
        style="top: {coords.top}px; left: {coords.left}px;"
        in:fade={{ duration: 150 }}
    >
        <div
            bind:this={dialogEl}
            class={'sa-suggestion-modal-popup-content'}
            style="border-top: 3px solid {themeColor}"
            role="dialog"
            aria-modal="true"
            aria-labelledby="suggestion-modal-title"
            tabindex="-1"
        >
            <div class={'sa-suggestion-modal-popup-header'}>
                <span id="suggestion-modal-title" class={'sa-suggestion-modal-label'} style="color: {themeColor}">{themeLabel}</span>
                <div class={'sa-suggestion-modal-popup-header-actions'}>
                    <label class={'sa-suggestion-modal-auto-advance-toggle'} title="Na accepteren of afwijzen direct de volgende zichtbare suggestie openen">
                        <input
                            type="checkbox"
                            checked={$suggestionAutoAdvance}
                            on:change={toggleAutoAdvance}
                        />
                        <span class={'sa-suggestion-modal-auto-advance-label'}>Auto volgende</span>
                    </label>
                    <button
                        type="button"
                        class={'sa-suggestion-modal-btn-header-close'}
                        on:click={closeOnly}
                        aria-label="Sluiten"
                        title="Alleen sluiten; suggestie blijft in de lijst"
                    >
                        <i class="ph ph-x" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <div class={'sa-suggestion-modal-suggestion-body'}>
                {#if suggestion.b1AlternativesIncomplete}
                    <p class={'sa-suggestion-modal-incomplete-alts-hint'}>
                        Het model leverde minder dan twee herschrijvingen voor deze markering. Voer de B1-check desgewenst
                        opnieuw uit.
                    </p>
                {/if}
                {#if ruleDetailKeyList.length}
                    <p class={'sa-suggestion-modal-rationale'} title={ruleDetailsTooltip || undefined}>
                        <span class={'sa-suggestion-modal-rationale-prefix'}>Reden:</span>
                        {ruleDetailKeyList.join(', ')}
                    </p>
                {:else if ruleDetailsFallbackSummary}
                    <p class={'sa-suggestion-modal-rationale'} title={ruleDetailsFallbackProse || ruleDetailsTooltip || undefined}>
                        <span class={'sa-suggestion-modal-rationale-prefix'}>Reden:</span>
                        {ruleDetailsFallbackSummary}
                    </p>
                {:else if displayExplanationTrimmed}
                    <p class={'sa-suggestion-modal-rationale'}>
                        <span class={'sa-suggestion-modal-rationale-prefix'}>Reden:</span>
                        {displayExplanationTrimmed}
                    </p>
                {/if}
                {#if suggestion.handbookSnippet?.trim()}
                    <p class={'sa-suggestion-modal-handbook-snippet'} title="Broncitaat (indien opgegeven)">
                        <span class={'sa-suggestion-modal-handbook-snippet-prefix'}>Bron:</span>
                        {suggestion.handbookSnippet}
                    </p>
                {/if}
                {#if suggestion.referenceLinks?.length}
                    <ul class={'sa-suggestion-modal-reference-link-list'} aria-label="Hulplijsten en bronnen">
                        {#each suggestion.referenceLinks as link}
                            <li>
                                {#if safeLinkUrl(link.url)}
                                    <a
                                        href={safeLinkUrl(link.url)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class={'sa-suggestion-modal-reference-link'}>{link.label}</a>
                                {:else}
                                    {link.label}
                                {/if}
                            </li>
                        {/each}
                    </ul>
                {/if}
                {#if hasSuggestedProposal}
                    <div class={'sa-suggestion-modal-suggestion-proposal'}>
                        {#if showAlternativePicker}
                            <div class={'sa-suggestion-modal-alt-picker'} role="radiogroup" aria-label="Kies een herschrijving">
                                {#each alternativeList as alt, i}
                                    <label
                                        class="{'sa-suggestion-modal-alt-option'} {selectedAlternativeIndex === i ? 'sa-suggestion-modal-alt-option--selected' : ''}"
                                    >
                                        <input
                                            type="radio"
                                            name="b1-alt-{suggestion.id}"
                                            checked={selectedAlternativeIndex === i}
                                            on:change={() => (selectedAlternativeIndex = i)}
                                        />
                                        <span class={'sa-suggestion-modal-alt-option-body'}>
                                            <span class={'sa-suggestion-modal-alt-option-label'}
                                                >Optie {i + 1} <span class={'sa-suggestion-modal-kbd-hint'}>({i + 1})</span></span
                                            >
                                            <span class={'sa-suggestion-modal-alt-option-text'}>{alt.tekst}</span>
                                        </span>
                                    </label>
                                {/each}
                            </div>
                        {:else if suggestion.suggestedText !== undefined && suggestion.suggestedText !== null}
                            <div class={'sa-suggestion-modal-suggestion-line'}>
                                <span class={'sa-suggestion-modal-sugg-label'}>Suggestie:</span>
                                <span
                                    class="{'sa-suggestion-modal-text'} {(modalKind === 'spelling' || displaySuggestedText !== displaySuggestedText.trim()) ? 'sa-suggestion-modal-text--pre' : ''}"
                                    >{displaySuggestedText === ''
                                        ? '(leeg — fragment verwijderen)'
                                        : displaySuggestedText}</span>
                            </div>
                            {#if suggestion.canAccept === false}
                                <p class={'sa-suggestion-modal-manual-replace-hint'}>
                                    Automatisch vervangen met de knop hieronder lukt niet (de tekst komt niet 1-op-1 overeen met
                                    wat gemarkeerd is). Kopieer de suggestie desnoods handmatig.
                                </p>
                            {/if}
                        {:else if suggestion.ruleDetails?.length}
                            <p class={'sa-suggestion-modal-no-replace-hint'}>Er is geen suggestie-tekst in dit antwoord.</p>
                        {/if}
                    </div>
                {/if}
            </div>
            <div class={'sa-suggestion-modal-actions-footer'}>
                <button
                    type="button"
                    class={'sa-suggestion-modal-btn-deny'}
                    on:click={deny}
                    title="Afwijzen: uit lijst en editor (sneltoets N)"
                >
                    <i class="ph-bold ph-x"></i> Afwijzen
                </button>
                <button
                    type="button"
                    class={'sa-suggestion-modal-btn-accept'}
                    on:click={accept}
                    style="background: {themeColor}"
                    disabled={!acceptEnabled}
                    title="Accepteren (Y)"
                >
                    <i class="ph-bold ph-check"></i> Accepteren
                </button>
            </div>
            <p class={'sa-suggestion-modal-shortcut-hints'} aria-label="Sneltoetsen">
                {#if showAlternativePicker && alternativeList.length > 1}
                    <kbd>1</kbd>–<kbd>{Math.min(alternativeList.length, 2)}</kbd> optie ·
                {/if}
                <kbd>Y</kbd> ja · <kbd>N</kbd> nee · <kbd>[</kbd> vorige · <kbd>]</kbd> volgende
            </p>
        </div>
        <div class={'sa-suggestion-modal-arrow'}></div>
    </div>
{/if}
