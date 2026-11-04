<script>
    /**
     * Author right sidebar: metrics, template guidelines, AI feedback tabs (structure/B1/taalreview),
     * rule triggers and manual AI/taalreview actions; stays in sync with the active block via props/callbacks.
     */
    import { onDestroy, onMount, tick, getContext } from 'svelte';
    import { ROOT_EL_CONTEXT } from '$lib/hostBridge.js';
    import { setNotaHtml } from '$lib/utils/safetyFilter.js';
    import './AuteurPane.css';
    import { slide } from 'svelte/transition';
    import { get } from 'svelte/store';
    import { dbStore } from '$lib/store.js';
    import { calculateMetrics, calculateB1ParameterSnapshot, applyRealtimeHighlights, b1LexiconsLoaded } from '$lib/utils/analysis.js';
    import { ensureB1Lexicons } from '$lib/utils/b1LexiconLoader.js';
    import { ruleWordList } from '$lib/adminConfig.js';
    import {
        normalizeB1AlternativesFromItem,
        feedbackToSuggestions,
        suggestionDisplayText,
        mergeSpellingSuggestionsWithLocalSpaceRules
    } from '$lib/utils/suggestions.js';
    import { activeSuggestion as activeSuggestionStore, hoveredSuggestion as hoveredSuggestionStore } from '$lib/suggestionStore.js';
    import { naturalSort } from '$lib/utils/sorting.js';
    import B1MetricsPanel from './ui/B1MetricsPanel.svelte';
    import { safeLinkUrl } from '$lib/utils/safeUrl.js';
    import { DD_VISIBLE_METRICS } from '$lib/utils/b1Guidelines.js';
    import { uiSettings } from '$lib/uiStore.js';

    /**
     * Port: cross-component lookups are rooted at the app container instead of `document`
     * (the `.sa-root` element comes from App.svelte through context; without it `document` is used).
     * @type {HTMLElement | null}
     */
    const rootEl = getContext(ROOT_EL_CONTEXT) || null;
    /** @returns {ParentNode} */
    function root() {
        return rootEl || document;
    }

    export let nota;
    export let content;
    export let activeSuggestion = null;
    export let activeBlockId = null;
    export let activeNote = null;
    export let blocksAnalyzing = new Set();
    /** Populated from editor/modal; hides items in the right-hand tabs when dismissed. */
    export let dismissedSuggestionIds = new Set();
    /**
     * Maps suggestionId → { originalText, appliedText, blockId } for accepted items that can be undone.
     * Subset of dismissedSuggestionIds — items here were accepted (not just denied).
     * @type {Record<string, { originalText: string, appliedText: string, blockId: string }>}
     */
    export let acceptedSuggestions = {};
    /** Block workflow states map */
    export let blockWorkflowMap = {};
    /** Opens the same suggestion modal as from an inline highlight (id + blockId e.g. block-c1). */
    export let onOpenWorkspaceSuggestion = (suggestionId, blockId) => {};
    /** Called when author requests undo on a specific accepted suggestion. */
    export let onUndoSuggestion = (/** @type {string} */ suggestionId) => {};

    export let onsetActiveBlockId = (id) => {};
    export let onsetActiveSuggestion = (id) => {};
    export let ontoggleNoteResolved = (id) => {};
    export let onremoveNote = (id) => {};
    export let onsetActiveNote = (id) => {};
    export let ontriggerAi = (blockId, chapterId, content) => {};
    /** Taalreview (spelling, grammatica, leestekens) via agent `agent_spelling_grammatica`. */
    export let ontriggerSpelling = async (blockId, chapterId) => {};
    /** Woordenlijst (word-level agent); niet deel van automatische keten. */
    export let ontriggerWoordenlijst = async (blockId, chapterId) => {};
    /** Active block workflow is Done — no further AI/spelling runs. */
    export let isActiveBlockWorkflowDone = false;
    /** AI-fase: structuur/B1/spelling en “Check hoofdstuk” zijn actief. */
    export let isActiveBlockAiToolsEnabled = false;
    /** `'all' | 'structuur' | 'b1' | 'spelling'` — drives which inline editor markings Workspace shows. */
    export let onEditorHighlightFilterChange = (filter) => {};

    export let onUpdateHighlight = (text) => {};

    const STRUCT_SIDEBAR_SKIP = new Set([
        'Suggestie',
        'suggestie',
        'Suggesties',
        'FOUT',
        'RAW',
        'Origineel',
        'Original',
        'Verbetering',
        'explanation',
        'Uitleg',
        'ai_response',
        'feedback'
    ]);

    /** Opens a workspace suggestion and scrolls the matching sidebar row into view. */
    function handleSidebarSuggestionClick(suggestionId, blockId) {
        onOpenWorkspaceSuggestion(suggestionId, blockId);
        tick().then(() => {
            try {
                const id = String(suggestionId);
                const sel =
                    typeof CSS !== 'undefined' && CSS.escape
                        ? `[data-sidebar-suggestion-id="${CSS.escape(id)}"]`
                        : `[data-sidebar-suggestion-id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
                root().querySelector(sel)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } catch {
                /* ignore */
            }
        });
    }

    // Theme Colors
    const COLOR_STRUCTUUR = 'var(--sa-structuur-text)';
    const COLOR_B1 = 'var(--sa-b1-text)';
    const COLOR_SPELLING = 'var(--sa-spelling-text)';
    /** Woordenlijst tab / highlights */
    const COLOR_WOORDENLIJST = 'var(--sa-woordenlijst-text)';
    const COLOR_DEFAULT = 'var(--sa-primary-color)';

    $: activeChapterId = activeBlockId ? activeBlockId.replace('block-', '') : null;

    $: structuurFeedbackCount = (() => {
        if (!nota?.chapterFeedbacks || !activeChapterId || !nota.chapterFeedbacks[activeChapterId]) return 0;
        const parsed = parseAiResponse(nota.chapterFeedbacks[activeChapterId]);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null || parsed.FOUT) return 0;
        const plain = getActiveCellText(`block-${activeChapterId}`, content);
        const rows = feedbackToSuggestions(
            parsed,
            `block-${activeChapterId}`,
            activeChapterId,
            'agent_structuur',
            plain
        );
        return rows.filter((s) => !dismissedSuggestionIds.has(s.id)).length;
    })();

    $: b1FeedbackCount = (() => {
        if (!nota?.chapterFeedbacksB1 || !activeChapterId || !nota.chapterFeedbacksB1[activeChapterId]) return 0;
        const parsed = parseAiResponse(nota.chapterFeedbacksB1[activeChapterId]);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) return 0;
        const plain = getActiveCellText(`block-${activeChapterId}`, content);
        const rows = feedbackToSuggestions(
            parsed,
            `block-${activeChapterId}`,
            activeChapterId,
            'agent_b1',
            plain
        );
        return rows.filter((s) => !dismissedSuggestionIds.has(s.id)).length;
    })();

    $: woordenlijstFeedbackCount = (() => {
        if (!nota?.chapterFeedbacksWoordenlijst || !activeChapterId || !nota.chapterFeedbacksWoordenlijst[activeChapterId])
            return 0;
        const parsed = parseAiResponse(nota.chapterFeedbacksWoordenlijst[activeChapterId]);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) return 0;
        const plain = getActiveCellText(`block-${activeChapterId}`, content);
        const rows = feedbackToSuggestions(
            parsed,
            `block-${activeChapterId}`,
            activeChapterId,
            'agent_woordenlijst',
            plain
        );
        return rows.filter((s) => !dismissedSuggestionIds.has(s.id)).length;
    })();

    // Known behaviour: the sidebar recomputes spelling rows from `content` with `canAccept` (Origineel still in the
    // text); after an accept the original is gone, so the row disappears and "Ongedaan maken" is unreachable. B1 rows keep their handled entry.
    $: spellingFeedbackCount = activeChapterId
        ? mergedSpellingRowsForChapter(activeChapterId).filter(
              (s) => s.canAccept !== false && !dismissedSuggestionIds.has(s.id)
          ).length
        : 0;

    let suggestions = [];
    let templateGuidelines = [];
    let activeTab = 'structuur'; // 'ai' | 'overview' | 'structuur' | 'comments' | 'b1'
    let paneTabsEl;
    let expandedGuidelineId = null;
    let lastEditorHighlightFilter = /** @type {'all' | 'structuur' | 'b1' | 'spelling' | 'woordenlijst' | null} */ (null);

    /** Tab drives inline markings: Spelling → green; B1 → blue; Woordenlijst → purple; Structure overview → yellow; Instructions → all. */
    $: {
        let f = /** @type {'all' | 'structuur' | 'b1' | 'spelling' | 'woordenlijst' | null} */ (null);
        if (activeTab === 'spelling') f = 'spelling';
        else if (activeTab === 'b1') f = 'b1';
        else if (activeTab === 'woordenlijst') f = 'woordenlijst';
        else if (activeTab === 'overview') f = 'structuur';
        else f = 'all';
        if (f !== lastEditorHighlightFilter) {
            lastEditorHighlightFilter = f;
            onEditorHighlightFilterChange(f);
        }
    }

    $: db = $dbStore;
    $: config = (db.configurations || []).find(c => c.id === (nota?.configId || 'conf-gs')) || db.configurations?.[0];
    $: templateGuidelines = naturalSort(config?.templateGuidelines || [], g => g.id);
    $: rules = config?.rules || [];

    /** One DOM subtree to plain text with \\n after block elements (paragraphs for B1 metrics). */
    function fragmentToPlainWithBreaks(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = /** @type {Element} */ (node);
        const tag = el.tagName.toLowerCase();
        if (tag === 'br') return '\n';
        let out = '';
        for (const child of Array.from(el.childNodes)) {
            out += fragmentToPlainWithBreaks(child);
        }
        const blockish = new Set([
            'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'blockquote', 'section', 'article', 'header', 'footer', 'main'
        ]);
        if (blockish.has(tag)) out += '\n';
        return out;
    }

    /**
     * Plain text for one block from full nota HTML (between its H2 and the next H2).
     * @param {string|null} blockId
     * @param {string} htmlContent
     */
    function getActiveCellText(blockId, htmlContent) {
        if (!blockId || !htmlContent) return '';
        const temp = document.createElement('div');
        // SAFETY: a detached div in the live document still fires `<img onerror>`; the filter runs first
        // (one parse per recompute; a clean string is returned as it is).
        setNotaHtml(temp, htmlContent);
        let capturing = false;
        let cellText = '';
        Array.from(temp.childNodes).forEach(node => {
            if (node.nodeType === 1 && node.classList.contains('dynamic-chapter')) {
                const chId = node.getAttribute('data-chapter-id');
                capturing = blockId === `block-${chId}`;
                if (capturing) cellText = '';
            } else if (capturing) {
                if (node.nodeType === Node.TEXT_NODE) {
                    cellText += (node.textContent || '') + ' ';
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    cellText += fragmentToPlainWithBreaks(node);
                }
            }
        });
        return cellText
            .replace(/\u00a0/g, ' ')
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter((l) => l.length > 0)
            .join('\n')
            .trim();
    }

    /**
     * Ruwe HTML van het tekstblad voor één block (header H2 niet mee), voor taalreview-spatieregels.
     * @param {string|null} blockId
     * @param {string} htmlContent
     */
    function getActiveCellHtml(blockId, htmlContent) {
        if (!blockId || !htmlContent) return '';
        const temp = document.createElement('div');
        // SAFETY: a detached div in the live document still fires `<img onerror>`; the filter runs first
        // (one parse per recompute; a clean string is returned as it is).
        setNotaHtml(temp, htmlContent);
        let capturing = false;
        /** @type {string[]} */
        const parts = [];
        Array.from(temp.childNodes).forEach((node) => {
            if (node.nodeType === 1 && /** @type {Element} */ (node).classList.contains('dynamic-chapter')) {
                const chId = /** @type {Element} */ (node).getAttribute('data-chapter-id');
                capturing = blockId === `block-${chId}`;
                if (capturing) parts.length = 0;
            } else if (capturing) {
                if (node.nodeType === 3) {
                    const t = node.textContent || '';
                    if (t) parts.push(t);
                } else if (node.nodeType === 1) {
                    parts.push(/** @type {Element} */ (node).outerHTML);
                }
            }
        });
        return parts.join('');
    }

    /** Agent-taalreview + lokale spatiekolommen voor één hoofdstuk (ook zonder opgeslagen API-resultaat). */
    function mergedSpellingRowsForChapter(guidelineId) {
        const blockIdSp = `block-${guidelineId}`;
        const plain = getActiveCellText(blockIdSp, content);
        const htmlSp = getActiveCellHtml(blockIdSp, content);
        const raw = nota?.chapterFeedbacksSpelling?.[guidelineId];
        let agentRows = [];
        if (raw) {
            const o = typeof raw === 'string' ? parseAiResponse(raw) : raw;
            if (o && typeof o === 'object' && !o.FOUT) {
                agentRows = feedbackToSuggestions(
                    o,
                    blockIdSp,
                    guidelineId,
                    'agent_spelling_grammatica',
                    plain,
                    'spelling',
                    htmlSp
                );
            }
        }
        return mergeSpellingSuggestionsWithLocalSpaceRules(htmlSp, blockIdSp, guidelineId, agentRows);
    }

    $: activeCellText = getActiveCellText(activeBlockId, content);
    $: metrics = calculateMetrics(activeCellText);
    // the B1 lexicons load on the first use of the Direct Duidelijk tab; the snapshot is computed once they are in.
    let b1LexiconsReady = b1LexiconsLoaded();
    let b1LexiconsFailed = false;
    $: if (activeTab === 'b1' && !b1LexiconsReady) {
        ensureB1Lexicons().then(
            () => { b1LexiconsReady = true; b1LexiconsFailed = false; },
            (err) => { console.error('B1 lexicons not loaded:', err); b1LexiconsFailed = true; }
        );
    }
    $: b1ParameterSnapshot = b1LexiconsReady ? calculateB1ParameterSnapshot(activeCellText) : null;

    $: activeCellTitle = (() => {
        if (!activeBlockId || !content) return '';
        const temp = document.createElement('div');
        setNotaHtml(temp, content); // SAFETY
        for (const node of Array.from(temp.querySelectorAll('.dynamic-chapter'))) {
            const chId = node.getAttribute('data-chapter-id');
            if (`block-${chId}` === activeBlockId) return node.textContent;
        }
        return '';
    })();

    $: {
        const found = [];
        const cellText = activeCellText || content.replace(/<[^>]*>/g, ' ');

        rules.forEach(rule => {
            // the configurator can store `triggerWords` and `alternatives` as a typed string (AdminDashboard.svelte);
            // `ruleWordList` reads a string as a comma list.
            ruleWordList(rule.triggerWords).forEach(trigger => {
                //: a trigger word is literal text. An empty or non-string entry (a trailing comma
                // in the configuration) matches nothing instead of everything.
                if (typeof trigger !== 'string' || trigger === '') return;
                if (cellText.toLowerCase().includes(trigger.toLowerCase())) {
                    found.push({
                        id: rule.id,
                        category: rule.category,
                        severity: rule.severity,
                        original: trigger,
                        alternatives: ruleWordList(rule.alternatives),
                        explanation: rule.explanation
                    });
                }
            });
        });
        suggestions = found;
    }

    // Handle intentional switches to AI or Comments tabs from external props
    // These tabs are now hidden, so this logic is no longer needed.
    // $: if (activeSuggestion && activeTab !== 'ai') {
    //     activeTab = 'ai';
    // } else if (activeNote && activeTab !== 'comments') {
    //     activeTab = 'comments';
    // }

    // Close modal when switching between suggestion tabs
    let paneTabScrollPreferCenter = false;

    $: if (activeTab) {
        activeSuggestionStore.set(null);
        const preferCenter = paneTabScrollPreferCenter;
        paneTabScrollPreferCenter = false;
        scrollActiveTabIntoView({ preferCenter });
    }

    const TAB_SCROLL_PADDING = 24;
    const TAB_EDGE_ZONE = 32;
    const TAB_EDGE_SCROLL_MIN = 0.8;
    const TAB_EDGE_SCROLL_MAX = 4;

    /** @type {number} */
    let paneTabsScrollRaf = 0;
    /** @type {-1 | 0 | 1} */
    let paneTabsScrollDir = 0;
    let paneTabsScrollSpeed = TAB_EDGE_SCROLL_MIN;

    function stopPaneTabsEdgeScroll() {
        paneTabsScrollDir = 0;
        if (paneTabsScrollRaf) {
            cancelAnimationFrame(paneTabsScrollRaf);
            paneTabsScrollRaf = 0;
        }
    }

    function paneTabsEdgeScrollStep() {
        const container = paneTabsEl;
        if (!container || paneTabsScrollDir === 0) {
            paneTabsScrollRaf = 0;
            return;
        }

        const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
        const next = container.scrollLeft + paneTabsScrollDir * paneTabsScrollSpeed;

        if (next <= 0) {
            container.scrollLeft = 0;
            stopPaneTabsEdgeScroll();
            return;
        }
        if (next >= maxScroll) {
            container.scrollLeft = maxScroll;
            stopPaneTabsEdgeScroll();
            return;
        }

        container.scrollLeft = next;
        paneTabsScrollRaf = requestAnimationFrame(paneTabsEdgeScrollStep);
    }

    function startPaneTabsEdgeScroll() {
        if (!paneTabsScrollRaf) {
            paneTabsScrollRaf = requestAnimationFrame(paneTabsEdgeScrollStep);
        }
    }

    /** @param {MouseEvent} event */
    function handlePaneTabsMouseMove(event) {
        const container = paneTabsEl;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const width = rect.width;
        const maxScroll = container.scrollWidth - container.clientWidth;

        if (maxScroll <= 0) {
            stopPaneTabsEdgeScroll();
            return;
        }

        const leftDist = x;
        const rightDist = width - x;

        if (leftDist <= TAB_EDGE_ZONE && container.scrollLeft > 0) {
            paneTabsScrollDir = -1;
            const proximity = 1 - leftDist / TAB_EDGE_ZONE;
            paneTabsScrollSpeed =
                TAB_EDGE_SCROLL_MIN + proximity * (TAB_EDGE_SCROLL_MAX - TAB_EDGE_SCROLL_MIN);
            startPaneTabsEdgeScroll();
        } else if (rightDist <= TAB_EDGE_ZONE && container.scrollLeft < maxScroll - 1) {
            paneTabsScrollDir = 1;
            const proximity = 1 - rightDist / TAB_EDGE_ZONE;
            paneTabsScrollSpeed =
                TAB_EDGE_SCROLL_MIN + proximity * (TAB_EDGE_SCROLL_MAX - TAB_EDGE_SCROLL_MIN);
            startPaneTabsEdgeScroll();
        } else {
            stopPaneTabsEdgeScroll();
        }
    }

    function handlePaneTabsMouseLeave() {
        stopPaneTabsEdgeScroll();
    }

    onDestroy(stopPaneTabsEdgeScroll);
    // the page-global `CSS.highlights` entry holds ranges of this DOM; clear it with the pane
    onDestroy(() => applyRealtimeHighlights(null, null));

    /** @param {string} tabId */
    function selectPaneTab(tabId) {
        stopPaneTabsEdgeScroll();
        paneTabScrollPreferCenter = true;
        activeTab = tabId;
    }

    /** @param {{ preferCenter?: boolean }} [options] */
    function scrollActiveTabIntoView({ preferCenter = false } = {}) {
        tick().then(() => {
            const container = paneTabsEl;
            const tab = container?.querySelector('.pane-tab.active');
            if (!container || !tab) return;

            const padding = TAB_SCROLL_PADDING;
            const containerWidth = container.clientWidth;
            const maxScroll = Math.max(0, container.scrollWidth - containerWidth);
            const tabLeft = tab.offsetLeft;
            const tabWidth = tab.offsetWidth;
            const tabRight = tabLeft + tabWidth;
            const scrollLeft = container.scrollLeft;
            const visibleRight = scrollLeft + containerWidth;

            let targetScroll = scrollLeft;

            if (preferCenter && tabWidth + padding * 2 <= containerWidth) {
                targetScroll = tabLeft - (containerWidth - tabWidth) / 2;
            } else if (tabLeft < scrollLeft + padding) {
                targetScroll = tabLeft - padding;
            } else if (tabRight > visibleRight - padding) {
                targetScroll = tabRight - containerWidth + padding;
            }

            targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));

            if (Math.abs(targetScroll - scrollLeft) > 1) {
                container.scrollTo({ left: targetScroll, behavior: 'smooth' });
            }
        });
    }

    /** Template guideline click: jump to block and expand/collapse details. */
    function handleGuidelineClick(guidelineId) {
        const blockId = `block-${guidelineId}`;
        const isAlreadyActive = activeBlockId === blockId;
        onsetActiveBlockId(blockId);
        onsetActiveSuggestion(null);
        if (isAlreadyActive) {
            expandedGuidelineId = expandedGuidelineId === guidelineId ? null : guidelineId;
        } else {
            expandedGuidelineId = guidelineId;
        }
    }

    $: if (activeBlockId && typeof document !== 'undefined') {
        const cellEl = root().querySelector(`[data-block-id="${activeBlockId}"] .cell-content`);
        if (cellEl) {
            applyRealtimeHighlights(cellEl, suggestions);
        }
    }

    /** Forwards to workspace: mark reviewer note resolved / unresolved. */
    function toggleNoteResolved(noteId) {
        ontoggleNoteResolved(noteId);
    }

    /** Forwards: remove note. */
    function removeNote(noteId) {
        onremoveNote(noteId);
    }

    /** Same hash-to-colour strategy as Workspace for reviewer highlights. */
    function getReviewerColor(name) {
        const REVIEWER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const index = Math.abs(hash) % REVIEWER_COLORS.length;
        return REVIEWER_COLORS[index];
    }

    /** LanguageTool/spelling only for the active block. */
    function runSpellingCheckManual() {
        if (!activeBlockId || isActiveBlockWorkflowDone || !isActiveBlockAiToolsEnabled) return;
        const guideline = templateGuidelines.find((g) => `block-${g.id}` === activeBlockId);
        if (!guideline) return;
        ontriggerSpelling(activeBlockId, guideline.id);
    }

    /**
     * Parses JSON AI feedback (string or object) for sidebar tables; tolerates markdown code fences.
     * @param {string|object|null|undefined} text
     */
    function parseAiResponse(text) {
        if (!text) return null;

        // If it's already an object (e.g. from validated backend response), return it directly
        if (typeof text === 'object' && !Array.isArray(text)) {
            return text;
        }

        // Otherwise assume it's a string and proceed with parsing
        if (typeof text !== 'string') return { "Feedback": String(text) };

        const trimmed = text.trim();
        // Try to find a JSON block in the text if it's not just pure JSON
        let jsonStr = trimmed;
        const match = trimmed.match(/```json\n?([\s\S]*?)\n?```/);
        if (match) {
            jsonStr = match[1].trim();
        } else if (trimmed.includes('{')) {
            // Primitive attempt to extract JSON if there's other text
            const firstBrace = trimmed.indexOf('{');
            const lastBrace = trimmed.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
            }
        }

        try {
            const parsed = JSON.parse(jsonStr);
            // Handle common wrapper keys if the whole thing was wrapped
            if (parsed.ai_response && typeof parsed.ai_response === 'object') return parsed.ai_response;
            if (parsed.feedback && typeof parsed.feedback === 'object') return parsed.feedback;
            return parsed; // already an object
        } catch (e) {
            // Not valid JSON, return as is (wrapped in a default key or just string)
            return { "Feedback": trimmed.replace(/```json\n?|```/g, '').trim() };
        }
    }

    /** IDs of handled (accepted/denied) rows that are currently expanded to show the diff. */
    let expandedHandledIds = new Set();

    /** IDs of active suggestions that are currently expanded. */
    let expandedSuggestionIds = new Set();

    /**
     * Toggles the expand state of a handled suggestion row.
     * @param {string} id
     */
    function toggleHandledRow(id) {
        const next = new Set(expandedHandledIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        expandedHandledIds = next;
    }

    /**
     * Toggles the expand state of an active suggestion.
     * @param {string} id
     */
    function toggleSuggestion(id) {
        const next = new Set();
        if (!expandedSuggestionIds.has(id)) {
            // Opening a new suggestion - close all others and open only this one
            next.add(id);
        }
        // If already open, close it (keep set empty)
        expandedSuggestionIds = next;
    }

    /**
     * Filters suggestions based on workflow state.
     * If workflow is done/review, only show handled suggestions.
     * @param {Array} suggestions - Array of suggestions
     * @param {string} chapterId - Chapter/guideline ID
     * @returns {Array} Filtered suggestions
     */
    function filterSuggestionsByWorkflow(suggestions, chapterId) {
        if (!suggestions || !suggestions.length) return suggestions;
        // Known behaviour: `blockWorkflowMap` is keyed by block id (`block-h3`) while `chapterId` is `h3`, so this
        // lookup never matches and the sidebar keeps listing open rows of a done or review block; only the editor hides them.
        const workflowState = blockWorkflowMap[chapterId];
        if (workflowState === 'done' || workflowState === 'review') {
            // Only show handled suggestions (dismissed or accepted)
            return suggestions.filter(s => dismissedSuggestionIds.has(s.id) || (s.id in acceptedSuggestions));
        }
        return suggestions;
    }

    // Scroll to hovered suggestion in sidebar when hovering over text
    $: if ($hoveredSuggestionStore?.source === 'text') {
        tick().then(() => {
            const element = root().querySelector(`[data-sidebar-suggestion-id="${$hoveredSuggestionStore.id}"]`);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    // Scroll to active suggestion when it changes (clicked in tab or text)
    $: if ($activeSuggestionStore?.highlightId) {
        tick().then(() => {
            const element = root().querySelector(`[data-sidebar-suggestion-id="${$activeSuggestionStore.highlightId}"]`);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }
</script>

<section class="right-pane-section">
    <div
        class="pane-tabs"
        bind:this={paneTabsEl}
        on:mousemove={handlePaneTabsMouseMove}
        on:mouseleave={handlePaneTabsMouseLeave}
    >
        <button
            class="pane-tab structuur-tab {activeTab === 'structuur' ? 'active' : ''}"
            data-tab="structuur"
            style="--sa-active-color: {COLOR_STRUCTUUR}"
            title="Structuur Instructies"
            on:click={() => selectPaneTab('structuur')}>
            <i class="ph-bold ph-columns"></i> Instructies
        </button>
        <button
            class="pane-tab structuur-tab {activeTab === 'overview' ? 'active' : ''}"
            data-tab="overview"
            style="--sa-active-color: {COLOR_STRUCTUUR}"
            title="Structuur feedback"
            on:click={() => selectPaneTab('overview')}>
            <i class="ph-bold ph-list-numbers"></i> Structuur
            {#if structuurFeedbackCount > 0}
                <span class="stats-badge" style="margin-left: 4px; background: {COLOR_STRUCTUUR}; color: var(--sa-bg-panel)">{structuurFeedbackCount}</span>
            {/if}
        </button>
        <button
            class="pane-tab spelling-tab {activeTab === 'spelling' ? 'active' : ''}"
            data-tab="spelling"
            style="--sa-active-color: {COLOR_SPELLING}"
            title="Spelling, grammatica en leestekens"
            on:click={() => selectPaneTab('spelling')}>
            <i class="ph-bold ph-spell-check"></i> Spelling
            {#if spellingFeedbackCount > 0}
                <span class="stats-badge" style="margin-left: 4px; background: {COLOR_SPELLING}; color: var(--sa-bg-panel)">{spellingFeedbackCount}</span>
            {/if}
        </button>
        <button
            class="pane-tab b1-tab {activeTab === 'b1' ? 'active' : ''}"
            data-tab="b1"
            style="--sa-active-color: {COLOR_B1}"
            title="Direct Duidelijk — taal en leesbaarheid"
            on:click={() => selectPaneTab('b1')}>
            <i class="ph-bold ph-text-b-one"></i> Direct Duidelijk
            {#if b1FeedbackCount > 0}
                <span class="stats-badge" style="margin-left: 4px; background: {COLOR_B1}; color: var(--sa-bg-panel)">{b1FeedbackCount}</span>
            {/if}
        </button>
        <button
            class="pane-tab woordenlijst-tab {activeTab === 'woordenlijst' ? 'active' : ''}"
            data-tab="woordenlijst"
            style="--sa-active-color: {COLOR_WOORDENLIJST}"
            title="Woordenlijst — woordniveau B1, vaag, jargon"
            on:click={() => selectPaneTab('woordenlijst')}>
            <i class="ph-bold ph-text-aa"></i> Woordenlijst
            {#if woordenlijstFeedbackCount > 0}
                <span class="stats-badge" style="margin-left: 4px; background: {COLOR_WOORDENLIJST}; color: var(--sa-bg-panel)">{woordenlijstFeedbackCount}</span>
            {/if}
        </button>
    </div>

    <div class="pane-list" style="margin-top: 0">
        {#if activeTab === 'comments'}
            {#if !nota || !nota.notes || nota.notes.length === 0}
                <div style="text-align: center; color: var(--sa-text-muted); margin-top: 40px">Geen notities van reviewers gevonden.</div>
            {:else}
                {#each nota.notes as note (note.id || note.timestamp)}
                    {@const rColor = getReviewerColor(note.reviewerName)}
                    <div
                        class="review-checklist-card {activeNote === note.id ? 'active' : ''}"
                        style="border-left: 4px solid {rColor}; opacity: {note.resolved ? 0.6 : 1}; background-color: {note.resolved ? 'var(--sa-bg-sidebar)' : ''}; filter: {note.resolved ? 'grayscale(80%)' : 'none'}"
                        on:click={() => onsetActiveNote(note.id)}
                        role="button"
                        tabindex="0"
                        on:keydown={(e) => e.key === 'Enter' && onsetActiveNote(note.id)}
                    >
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid var(--sa-border-color); padding-bottom: 8px">
                            <div style="display: flex; align-items: center; gap: 8px">
                                <div style="width: 24px; height: 24px; border-radius: 50%; background-color: {rColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: bold">
                                    {note.reviewerName.charAt(0)}
                                </div>
                                <strong style="font-size: 0.85rem; color: {note.resolved ? 'var(--sa-text-muted)' : 'inherit'}; text-decoration: {note.resolved ? 'line-through' : 'none'}">{note.reviewerName}</strong>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px">
                                {#if note.resolved}
                                    <span style="font-size: 0.75rem; color: var(--sa-text-muted); font-weight: bold"><i class="ph-bold ph-check-circle"></i> Opgelost</span>
                                {/if}
                                <span style="font-size: 0.75rem; color: var(--sa-text-muted)">
                                    {new Date(note.timestamp).toLocaleDateString('nl-NL')}
                                </span>
                            </div>
                        </div>
                        <div style="margin-bottom: 8px">
                            <span style="font-size: 0.7rem; font-weight: bold; text-transform: uppercase; color: {rColor}; background-color: {rColor}15; padding: 2px 6px; border-radius: 4px">
                                {note.type || 'Opmerking'}
                            </span>
                        </div>
                        <p style="font-size: 0.875rem; color: {note.resolved ? 'var(--sa-text-muted)' : 'var(--sa-text-main)'}; margin: 0; white-space: pre-wrap; text-decoration: {note.resolved ? 'line-through' : 'none'}">{note.text}</p>
                        <div style="display: flex; gap: 8px; margin-top: 12px">
                            <button class="sa-btn sa-btn-secondary" style="font-size: 0.75rem; padding: 4px 8px" on:click|stopPropagation={() => toggleNoteResolved(note.id)}>
                                {note.resolved ? 'Heropen Notitie' : 'Markeer als Opgelost'}
                            </button>
                            <button class="sa-btn sa-btn-danger" style="font-size: 0.75rem; padding: 4px 8px" on:click|stopPropagation={() => removeNote(note.id)} title="Verwijder notitie">
                                <i class="ph-bold ph-trash"></i>
                            </button>
                        </div>
                    </div>
                {/each}
            {/if}
        {:else if activeTab === 'ai'}
            {#if !activeBlockId}
                <div class="tm-select-prompt">
                    <i class="ph-bold ph-cursor-click" style="font-size: 32px; color: var(--sa-primary-text); opacity: 0.6"></i>
                    <p>Klik op een cel in de editor om de tekstanalyse te zien.</p>
                </div>
            {:else if metrics}
                <!-- the legacy gauges (readability, formality, inclusivity) are dropped; this tab is not reachable (`activeTab` is never set to 'ai', see the commented reactive block above). -->

                <div class="tm-suggestions-section">
                    <div class="tm-section-label">
                        <i class="ph-bold ph-magic-wand"></i>
                        Taalsuggesties
                        {#if suggestions.length > 0}
                            <span class="tm-sugg-count">{suggestions.length}</span>
                        {/if}
                    </div>

                    {#if suggestions.length === 0 && (!metrics.spellingErrors || metrics.spellingErrors.length === 0)}
                        <div style="text-align: center; color: var(--sa-text-muted); padding: 20px 0">
                            <i class="ph-bold ph-check-circle" style="font-size: 32px; color: var(--sa-color-green)"></i>
                            <p style="margin-top: 8px; font-size: 0.875rem">Geen spelling-, grammatica- of leestekensactie vereist!</p>
                        </div>
                    {:else}
                        {#if metrics.spellingErrors && metrics.spellingErrors.length > 0}
                            {#each metrics.spellingErrors as err}
                                <div class="suggestion-card" style="border-left-color: var(--sa-color-red)">
                                    <div class="sa-card-header">
                                        <div class="severity-indicator severity-high"></div>
                                        <span class="sa-card-category">Spelling</span>
                                    </div>
                                    <div class="sa-card-content">
                                        <div class="original-text"><span style="text-decoration: underline decoration-wavy decoration-red-500; color: var(--sa-color-red-text)">"{err.wrong}"</span></div>
                                    </div>
                                    <div class="alternatives-container">
                                        <button class="alternative-btn"><span>{err.correct}</span><i class="ph-bold ph-check"></i></button>
                                    </div>
                                </div>
                            {/each}
                        {/if}

                        {#each suggestions as sug (sug.id)}
                            <div
                                class="suggestion-card {activeSuggestion === sug.id ? 'active' : ''}"
                                on:click={() => onsetActiveSuggestion(sug.id)}
                                role="button"
                                tabindex="0"
                                on:keydown={(e) => e.key === 'Enter' && onsetActiveSuggestion(sug.id)}
                            >
                                <div class="sa-card-header">
                                    <div class="severity-indicator severity-{sug.severity}"></div>
                                    <span class="sa-card-category">{sug.category}</span>
                                </div>
                                <div class="sa-card-content">
                                    <div class="original-text">"{sug.original}"</div>
                                </div>
                                {#if activeSuggestion === sug.id}
                                    <div class="alternatives-container">
                                        {#each sug.alternatives as alt}
                                            <button class="alternative-btn"><span>{alt}</span><i class="ph-bold ph-check"></i></button>
                                        {/each}
                                    </div>
                                    <div class="ai-explain"><strong>Reden:</strong> {sug.explanation}</div>
                                {/if}
                            </div>
                        {/each}
                    {/if}
                </div>
            {:else}
                <div class="tm-select-prompt">
                    <i class="ph-bold ph-pencil-simple" style="font-size: 28px; color: var(--sa-text-muted)"></i>
                    <p>Begin met typen om de analyse te starten.</p>
                </div>
            {/if}
        {:else if activeTab === 'structuur'}
            <div class="structuur-instructions-pane">
            {#if templateGuidelines.length === 0}
                <div style="text-align: center; color: var(--sa-text-muted); margin-top: 40px">Geen structuur instructies gevonden.</div>
            {:else}
                {#each (activeBlockId ? templateGuidelines.filter(g => `block-${g.id}` === activeBlockId) : templateGuidelines) as guideline (guideline.id)}
                    {@const isActive = activeBlockId === `block-${guideline.id}`}
                    {@const isExpanded = expandedGuidelineId === guideline.id}
                    <div
                        class="guideline-card {isActive ? 'active' : ''} {isExpanded ? 'guideline-expanded' : ''}"
                        on:click={() => handleGuidelineClick(guideline.id)}
                        role="button"
                        tabindex="0"
                        on:keydown={(e) => e.key === 'Enter' && handleGuidelineClick(guideline.id)}
                    >
                        <div class="guideline-card-header">
                            <div class="guideline-title">{guideline.titel}</div>
                            {#if isActive && isExpanded}
                                <div style="display: flex; gap: 8px; align-items: center">
                                    <button
                                        class="guideline-expand-btn"
                                        title="Minder tonen"
                                        on:click|stopPropagation={() => expandedGuidelineId = null}
                                    >
                                        <i class="ph-bold ph-caret-up"></i>
                                        Minder
                                    </button>
                                </div>
                            {:else if isActive}
                                <div style="display: flex; gap: 8px; align-items: center; color: var(--sa-text-muted); font-size: 0.75rem; pointer-events: none">
                                    <i class="ph-bold ph-caret-down"></i>
                                    Meer
                                </div>
                            {/if}
                        </div>

                        {#if isActive && !isExpanded}
                            <div class="guideline-preview">
                                <p class="guideline-preview-text">{guideline.doel}</p>
                            </div>
                        {/if}

                        {#if isActive && isExpanded}
                            <div class="guideline-details" style="margin-top: 12px">
                                <div class="guideline-section">
                                    <h4><i class="ph-bold ph-target" style="margin-right: 4px"></i> Doel</h4>
                                    <p>{guideline.doel}</p>
                                </div>
                                <div class="guideline-section">
                                    <h4><i class="ph-bold ph-check-square" style="margin-right: 4px"></i> Vereisten / Hoe het moet</h4>
                                    <ul>
                                        {#each (guideline.vereisten || []) as v}
                                            <li>{v}</li>
                                        {/each}
                                    </ul>
                                </div>
                                {#if guideline.voorbeelden && guideline.voorbeelden.length > 0}
                                    <div class="guideline-section">
                                        <h4><i class="ph-bold ph-thumbs-up" style="margin-right: 4px; color: var(--sa-color-green)"></i> Voorbeelden</h4>
                                        <ul class="example-list good-examples">
                                            {#each (guideline.voorbeelden || []) as v}
                                                <li><span style="color: var(--sa-color-green); margin-right: 4px">✓</span> {v}</li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                                {#if guideline.fout_voorbeelden && guideline.fout_voorbeelden.length > 0}
                                    <div class="guideline-section">
                                        <h4><i class="ph-bold ph-thumbs-down" style="margin-right: 4px; color: var(--sa-color-red-text)"></i> Hoe het niet moet</h4>
                                        <ul class="example-list bad-examples">
                                            {#each (guideline.fout_voorbeelden || []) as v}
                                                <li><span style="color: var(--sa-color-red-text); margin-right: 4px">✗</span> {v}</li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
            {/if}
            </div>
        {:else if activeTab === 'overview'}
            <div class="tm-overview-section">
                <div class="tm-section-header" style="display: flex; align-items: center; margin-bottom: 24px">
                    <h3 style="font-size: 1.1rem; font-weight: 700; color: var(--sa-structuur-text); display: flex; align-items: center; gap: 8px; margin: 0">
                        <i class="ph-bold ph-list-numbers"></i> Structuur Check
                    </h3>
                </div>

                {#if nota.chapterFeedbacks && Object.keys(nota.chapterFeedbacks).length > 0}
                    <div class="consolidated-feedback-section">
                        <div style="display: flex; flex-direction: column; gap: 20px">
                            {#each (activeBlockId ? templateGuidelines.filter(g => `block-${g.id}` === activeBlockId) : templateGuidelines) as guideline}
                                {#if nota?.chapterFeedbacks && nota.chapterFeedbacks[guideline.id]}
                                    <div class="chapter-feedback-card" style="background: var(--sa-bg-panel); border: 1px solid var(--sa-border-color); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.02)">
                                        <div style="padding: 10px 14px; background: var(--sa-bg-sidebar); border-bottom: 1px solid var(--sa-border-color); font-weight: 700; font-size: 0.8rem; color: var(--sa-structuur-text); display: flex; align-items: center; gap: 8px">
                                            <span class="idx" style="background: {COLOR_STRUCTUUR}; color: var(--sa-bg-panel); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem">{guideline.id}</span>
                                            {guideline.titel}
                                        </div>
                                        <div style="padding: 14px; display: flex; flex-direction: column; gap: 10px">
                                            {#if parseAiResponse(nota.chapterFeedbacks[guideline.id])}
                                                {@const parsed = parseAiResponse(nota.chapterFeedbacks[guideline.id])}
                                                {#if typeof parsed === 'object' && !Array.isArray(parsed)}
                                                    {#if parsed.FOUT}
                                                        <div class="feedback-pair" style="border-left: 3px solid var(--sa-color-red); background: rgba(239, 68, 68, 0.05); padding: 10px; border-radius: 6px;">
                                                            <div style="font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--sa-color-red-text); margin-bottom: 4px; letter-spacing: 0.05em">
                                                                <i class="ph-bold ph-warning-circle"></i> Validatie Fout
                                                            </div>
                                                            <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-color-red-text); font-weight: 500">
                                                                {parsed.FOUT}
                                                            </div>
                                                            {#if parsed.RAW}
                                                                <details style="margin-top: 10px; font-size: 0.75rem; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; overflow: hidden">
                                                                    <summary style="padding: 6px 10px; background: rgba(239, 68, 68, 0.03); cursor: pointer; color: var(--sa-color-red-text); font-weight: 600; list-style: none; display: flex; align-items: center; gap: 4px">
                                                                        <i class="ph ph-caret-right"></i> Toon Ruw Antwoord
                                                                    </summary>
                                                                    <pre style="padding: 10px; margin: 0; background: var(--sa-bg-panel); overflow-x: auto; white-space: pre-wrap; font-family: monospace; color: var(--sa-text-main); border-top: 1px solid rgba(239, 68, 68, 0.1); font-size: 0.7rem; line-height: 1.4">{parsed.RAW}</pre>
                                                                </details>
                                                            {/if}
                                                        </div>
                                                    {:else}
                                                        {@const blockIdStruct = `block-${guideline.id}`}
                                                        {@const plainStruct = getActiveCellText(blockIdStruct, content)}
                                                        {@const structRowsOv = filterSuggestionsByWorkflow(feedbackToSuggestions(
                                                            parsed,
                                                            blockIdStruct,
                                                            guideline.id,
                                                            'agent_structuur',
                                                            plainStruct
                                                        ), guideline.id)}
                                                        {#if structRowsOv.length && dismissedSuggestionIds.has(structRowsOv[0].id)}
                                                            {@const structId = structRowsOv[0].id}
                                                            {@const structWasAccepted = structId in acceptedSuggestions}
                                                            {@const structEntry = acceptedSuggestions[structId]}
                                                            {@const structExpanded = expandedHandledIds.has(structId)}
                                                            <div class={'sa-auteur-pane-sidebar-row--handled'} data-sidebar-suggestion-id={structId}>
                                                                <button
                                                                    class={'sa-auteur-pane-handled-header'}
                                                                    on:click={() => toggleHandledRow(structId)}
                                                                    aria-expanded={structExpanded}
                                                                >
                                                                    <span class={'sa-auteur-pane-handled-label'}>{structWasAccepted ? 'Geaccepteerd' : 'Afgewezen'}</span>
                                                                    <span class={'sa-auteur-pane-handled-text'}>{structEntry?.originalText ?? '—'}</span>
                                                                    <i class="ph {structExpanded ? 'ph-caret-up' : 'ph-caret-down'} {'sa-auteur-pane-handled-caret'}" aria-hidden="true"></i>
                                                                </button>
                                                                {#if structExpanded}
                                                                    <div class={'sa-auteur-pane-handled-detail'}>
                                                                        <div class={'sa-auteur-pane-diff-block'}>
                                                                            <div class={'sa-auteur-pane-diff-row'}>
                                                                                <span class={'sa-auteur-pane-diff-label'}>Origineel</span>
                                                                                <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--removed'}">{structEntry?.originalText ?? '—'}</span>
                                                                            </div>
                                                                            {#if structWasAccepted && structEntry?.appliedText}
                                                                                <div class={'sa-auteur-pane-diff-row'}>
                                                                                    <span class={'sa-auteur-pane-diff-label'}>Vervangen door</span>
                                                                                    <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--added'}">{structEntry.appliedText}</span>
                                                                                </div>
                                                                            {/if}
                                                                        </div>
                                                                        {#if structWasAccepted}
                                                                            <button
                                                                                type="button"
                                                                                class={'sa-auteur-pane-btn-undo-suggestion'}
                                                                                on:click|stopPropagation={() => onUndoSuggestion(structId)}
                                                                            >
                                                                                Ongedaan maken
                                                                            </button>
                                                                        {/if}
                                                                    </div>
                                                                {/if}
                                                            </div>
                                                        {:else}
                                                            {#if structRowsOv.length}
                                                                {@const isExpanded = expandedSuggestionIds.has(structRowsOv[0].id) || $activeSuggestionStore?.highlightId === structRowsOv[0].id}
                                                                {@const isHovered = $hoveredSuggestionStore?.id === structRowsOv[0].id}
                                                                {@const borderColor = $activeSuggestionStore?.highlightId === structRowsOv[0].id ? '#f1c40f' : (isHovered ? 'rgba(241, 196, 15, 0.5)' : 'var(--sa-border-color)')}
                                                                <div
                                                                    data-sidebar-suggestion-id={structRowsOv[0].id}
                                                                    class="minimal-suggestion"
                                                                    style="border: 1px solid {borderColor}; border-radius: 8px; margin-bottom: 12px; background: var(--sa-bg-panel); transition: all 0.2s;"
                                                                    on:mouseenter={() => hoveredSuggestionStore.set({ id: structRowsOv[0].id, source: 'tab' })}
                                                                    on:mouseleave={() => hoveredSuggestionStore.set(null)}
                                                                >
                                                                    <!-- Clickable Header -->
                                                                    <div
                                                                        role="button"
                                                                        tabindex="0"
                                                                        class="suggestion-header"
                                                                        style="padding: 10px 12px; cursor: pointer; display: flex; align-items: start; gap: 8px; justify-content: space-between;"
                                                                        on:click={() => {
                                                                            if ($activeSuggestionStore?.highlightId === structRowsOv[0].id) {
                                                                                // Already active - close it
                                                                                activeSuggestionStore.set(null);
                                                                                expandedSuggestionIds = new Set();
                                                                            } else {
                                                                                toggleSuggestion(structRowsOv[0].id);
                                                                                handleSidebarSuggestionClick(structRowsOv[0].id, blockIdStruct);
                                                                            }
                                                                        }}
                                                                        on:keypress={(e) => {
                                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                                e.preventDefault();
                                                                                if ($activeSuggestionStore?.highlightId === structRowsOv[0].id) {
                                                                                    activeSuggestionStore.set(null);
                                                                                    expandedSuggestionIds = new Set();
                                                                                } else {
                                                                                    toggleSuggestion(structRowsOv[0].id);
                                                                                    handleSidebarSuggestionClick(structRowsOv[0].id, blockIdStruct);
                                                                                }
                                                                            }
                                                                        }}
                                                                    >
                                                                        <div style="flex: 1; font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main);">
                                                                            {structRowsOv[0].original || '—'}
                                                                        </div>
                                                                        <i class="ph-bold {isExpanded ? 'ph-caret-up' : 'ph-caret-down'}" style="color: var(--sa-text-muted); flex-shrink: 0; margin-top: 2px;"></i>
                                                                    </div>

                                                                    {#if isExpanded}
                                                                        <div style="padding: 0 12px 12px 12px; border-top: 1px solid var(--sa-border-color);">
                                                                            <!-- Suggestie -->
                                                                            <div style="margin-top: 12px; padding: 10px; background: var(--sa-ok-bg); border-radius: 6px; border-left: 3px solid var(--sa-ok-accent);">
                                                                                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main);">
                                                                                    {structRowsOv[0].suggested || '—'}
                                                                                </div>
                                                                            </div>

                                                                                <!-- Argumentatie / Feedback items integrated -->
                                                                            {#if structRowsOv[0].ruleDetails && structRowsOv[0].ruleDetails.length > 0}
                                                                                <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
                                                                                    {#each structRowsOv[0].ruleDetails as detail}
                                                                                        <div style="padding: 8px; background: var(--sa-color-yellow-bg); border-radius: 6px; border-left: 3px solid var(--sa-color-yellow);">
                                                                                            <div style="font-size: 0.7rem; font-weight: 700; color: var(--sa-warn-text); margin-bottom: 2px;">
                                                                                                {detail.key}
                                                                                            </div>
                                                                                            <div style="font-size: 0.82rem; line-height: 1.5; color: var(--sa-text-main);">
                                                                                                {detail.text}
                                                                                            </div>
                                                                                        </div>
                                                                                    {/each}
                                                                                </div>
                                                                            {/if}

                                                                            <!-- "Klik om te markeren" hint -->
                                                                            <div style="margin-top: 12px; font-size: 0.7rem; color: var(--sa-text-muted); text-align: center; opacity: 0.6;">
                                                                                klik om in tekst te markeren
                                                                            </div>
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {/if}
                                                        {/if}
                                                    {/if}
                                                {:else}
                                                    <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                        {parsed}
                                                    </div>
                                                {/if}
                                            {:else}
                                                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                    {nota.chapterFeedbacks[guideline.id]}
                                                </div>
                                            {/if}
                                        </div>
                                    </div>
                                {/if}
                            {/each}
                        </div>
                    </div>
                {:else}
                    <div style="text-align: center; padding: 60px 20px; color: var(--sa-text-muted)">
                        <i class="ph-bold ph-info" style="font-size: 2rem; display: block; margin-bottom: 12px; opacity: 0.2"></i>
                        Geen feedback gevonden. Klik op het <i class="ph-bold ph-sparkle"></i> icoon in de editor om de AI te starten.
                    </div>
                {/if}
            </div>
        {:else if activeTab === 'b1'}
            <div class="tm-overview-section">
                {#if $uiSettings.showDdMetrics}
                    <B1MetricsPanel
                        snapshot={b1ParameterSnapshot}
                        cellTitle={activeCellTitle}
                        b1GuidelinesOverride={config?.b1Guidelines}
                        visibleMetricKeys={DD_VISIBLE_METRICS}
                        useDdScoreWeights={true}
                        panelTitle="Direct Duidelijk (indicatief)"
                    />
                    {#if b1LexiconsFailed}
                        <p class="text-muted" role="status">De woordenlijsten voor Direct Duidelijk konden niet worden geladen. Ga naar een ander tabblad en terug om het opnieuw te proberen.</p>
                    {/if}
                {/if}
                <div class="tm-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px">
                    <h3 style="font-size: 1.1rem; font-weight: 700; color: var(--sa-primary-text); display: flex; align-items: center; gap: 8px; margin: 0">
                        <i class="ph-bold ph-text-b-one"></i> Direct Duidelijk
                    </h3>
                </div>

                {#if nota.chapterFeedbacksB1 && Object.keys(nota.chapterFeedbacksB1).length > 0}
                    <div class="consolidated-feedback-section">
                        <div style="display: flex; flex-direction: column; gap: 20px">
                            {#each (activeBlockId ? templateGuidelines.filter(g => `block-${g.id}` === activeBlockId) : templateGuidelines) as guideline}
                                {#if nota?.chapterFeedbacksB1 && nota.chapterFeedbacksB1[guideline.id]}
                                    <div class="chapter-feedback-card" style="background: var(--sa-bg-panel); border: 1px solid var(--sa-border-color); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.02)">
                                        <div style="padding: 10px 14px; background: var(--sa-bg-sidebar); border-bottom: 1px solid var(--sa-border-color); font-weight: 700; font-size: 0.8rem; color: var(--sa-primary-text); display: flex; align-items: center; gap: 8px">
                                            <span class="idx" style="background: var(--sa-b1-text); color: var(--sa-bg-panel); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem">{guideline.id}</span>
                                            {guideline.titel}
                                        </div>
                                        <div style="padding: 14px; display: flex; flex-direction: column; gap: 10px">
                                            {#if parseAiResponse(nota.chapterFeedbacksB1[guideline.id])}
                                                {@const parsed = parseAiResponse(nota.chapterFeedbacksB1[guideline.id])}
                                                {#if typeof parsed === 'object' && !Array.isArray(parsed)}
                                                    {#if parsed.FOUT}
                                                        <div class="feedback-pair" style="border-left: 3px solid var(--sa-color-red); background: rgba(239, 68, 68, 0.05); padding: 10px; border-radius: 6px;">
                                                            <div style="font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--sa-color-red-text); margin-bottom: 4px; letter-spacing: 0.05em">
                                                                <i class="ph-bold ph-warning-circle"></i> Validatie Fout
                                                            </div>
                                                            <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-color-red-text); font-weight: 500">
                                                                {parsed.FOUT}
                                                            </div>
                                                            {#if parsed.RAW}
                                                                <details style="margin-top: 10px; font-size: 0.75rem; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; overflow: hidden">
                                                                    <summary style="padding: 6px 10px; background: rgba(239, 68, 68, 0.03); cursor: pointer; color: var(--sa-color-red-text); font-weight: 600; list-style: none; display: flex; align-items: center; gap: 4px">
                                                                        <i class="ph ph-caret-right"></i> Toon Ruw Antwoord
                                                                    </summary>
                                                                    <pre style="padding: 10px; margin: 0; background: var(--sa-bg-panel); overflow-x: auto; white-space: pre-wrap; font-family: monospace; color: var(--sa-text-main); border-top: 1px solid rgba(239, 68, 68, 0.1); font-size: 0.7rem; line-height: 1.4">{parsed.RAW}</pre>
                                                                </details>
                                                            {/if}
                                                        </div>
                                                    {:else}
                                                        {@const blockIdB1 = `block-${guideline.id}`}
                                                        {@const plainB1 = getActiveCellText(blockIdB1, content)}
                                                        {@const allB1Rows = filterSuggestionsByWorkflow(feedbackToSuggestions(
                                                            parsed,
                                                            blockIdB1,
                                                            guideline.id,
                                                            'agent_b1',
                                                            plainB1
                                                        ), guideline.id)}
                                                        {@const b1Active = allB1Rows.filter(s => !dismissedSuggestionIds.has(s.id))}
                                                        {@const b1Handled = allB1Rows.filter(s => dismissedSuggestionIds.has(s.id))}
                                                        {#if b1Active.length > 0}
                                                            {#each b1Active as row (row.id)}
                                                                {@const isExpanded = expandedSuggestionIds.has(row.id) || $activeSuggestionStore?.highlightId === row.id}
                                                                {@const isHovered = $hoveredSuggestionStore?.id === row.id}
                                                                {@const borderColor = $activeSuggestionStore?.highlightId === row.id ? 'var(--sa-b1-text)' : (isHovered ? 'rgba(11, 110, 219, 0.5)' : 'var(--sa-border-color)')}
                                                                <div
                                                                    role="button"
                                                                    tabindex="0"
                                                                    data-sidebar-suggestion-id={row.id}
                                                                    class="feedback-pair"
                                                                    style="border: 1px solid {borderColor}; border-radius: 8px; margin-bottom: 12px; cursor: pointer; background: var(--sa-bg-panel); overflow: hidden;"
                                                                    on:mouseenter={() => hoveredSuggestionStore.set({ id: row.id, source: 'tab' })}
                                                                    on:mouseleave={() => hoveredSuggestionStore.set(null)}
                                                                    on:click={() => {
                                                                        if ($activeSuggestionStore?.highlightId === row.id) {
                                                                            // Already active - close it
                                                                            activeSuggestionStore.set(null);
                                                                            expandedSuggestionIds = new Set();
                                                                        } else {
                                                                            toggleSuggestion(row.id);
                                                                            handleSidebarSuggestionClick(row.id, blockIdB1);
                                                                        }
                                                                    }}
                                                                    on:keypress={(e) => {
                                                                        if (e.key === 'Enter' || e.key === ' ') {
                                                                            e.preventDefault();
                                                                            if ($activeSuggestionStore?.highlightId === row.id) {
                                                                                activeSuggestionStore.set(null);
                                                                                expandedSuggestionIds = new Set();
                                                                            } else {
                                                                                toggleSuggestion(row.id);
                                                                                handleSidebarSuggestionClick(
                                                                                    row.id,
                                                                                    blockIdB1
                                                                                );
                                                                            }
                                                                        }
                                                                    }}
                                                                >
                                                                    <!-- Clickable header -->
                                                                    <div style="padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                                                                        <div style="font-size: 0.88rem; line-height: 1.4; color: var(--sa-text-main); flex: 1;">
                                                                            {row.original || '—'}
                                                                        </div>
                                                                        <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'}" style="color: var(--sa-text-muted); font-size: 0.9rem; flex-shrink: 0;" aria-hidden="true"></i>
                                                                    </div>

                                                                    {#if isExpanded}
                                                                        <div style="padding: 0 12px 12px 12px; border-top: 1px solid var(--sa-border-color);">
                                                                            {#if row.b1AlternativesIncomplete}
                                                                                <p style="margin: 12px 0 8px; font-size: 0.72rem; color: var(--sa-warn-text); background: var(--sa-color-yellow-bg); border: 1px solid var(--sa-warn-border); border-radius: 6px; padding: 6px 8px; line-height: 1.35">
                                                                                    Minder dan twee herschrijvingen beschikbaar. Voer de Direct Duidelijk-check opnieuw uit.
                                                                                </p>
                                                                            {/if}

                                                                            <!-- Herschrijvingen -->
                                                                            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                                                                                {#each row.alternatives || [] as alt, altIdx}
                                                                                    <div style="background: var(--sa-ok-bg); border: 1px solid var(--sa-ok-border); border-radius: 8px; overflow: hidden">
                                                                                        <div style="padding: 5px 10px; border-bottom: 1px solid var(--sa-ok-border); font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sa-ok-text); display: flex; align-items: center; gap: 4px">
                                                                                            <i class="ph-bold ph-check-circle" style="font-size: 0.75rem"></i> Herschrijving {altIdx + 1}
                                                                                        </div>
                                                                                        <div style="padding: 8px 10px; font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main); background: var(--sa-bg-panel); border-left: 3px solid var(--sa-ok-accent)">
                                                                                            {alt.tekst}
                                                                                        </div>
                                                                                        {#if alt.uitleg}
                                                                                            <div style="padding: 7px 10px; border-top: 1px solid var(--sa-ok-border); font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45; background: var(--sa-ok-bg)">
                                                                                                {alt.uitleg}
                                                                                            </div>
                                                                                        {/if}
                                                                                    </div>
                                                                                {/each}
                                                                            </div>

                                                                            <!-- Hint at bottom -->
                                                                            <div style="text-align: center; margin-top: 10px; font-size: 0.68rem; color: var(--sa-text-muted);">
                                                                                klik om in tekst te markeren
                                                                            </div>
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        {:else if parsed.Suggesties && Array.isArray(parsed.Suggesties) && parsed.Suggesties.length === 0}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Geen concrete taalsuggesties in dit antwoord (lege lijst).
                                                            </div>
                                                        {:else if !parsed.Suggesties || !Array.isArray(parsed.Suggesties)}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Dit antwoord heeft geen geldige <strong>Suggesties</strong>-lijst. Voer de Direct Duidelijk-check opnieuw uit; het model moet alleen JSON met
                                                                <code>Suggesties</code> teruggeven.
                                                            </div>
                                                        {:else if b1Handled.length === 0}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Geen openstaande Direct Duidelijk-suggesties (afgehandeld of niet meer in de huidige tekst).
                                                            </div>
                                                        {/if}
                                                        {#if b1Handled.length > 0}
                                                            {#each b1Handled as row (row.id)}
                                                                {@const wasAccepted = row.id in acceptedSuggestions}
                                                                {@const entry = acceptedSuggestions[row.id]}
                                                                {@const isExpanded = expandedHandledIds.has(row.id)}
                                                                <div class={'sa-auteur-pane-sidebar-row--handled'} data-sidebar-suggestion-id={row.id}>
                                                                    <button
                                                                        class={'sa-auteur-pane-handled-header'}
                                                                        on:click={() => toggleHandledRow(row.id)}
                                                                        aria-expanded={isExpanded}
                                                                    >
                                                                        <span class={'sa-auteur-pane-handled-label'}>{wasAccepted ? 'Geaccepteerd' : 'Afgewezen'}</span>
                                                                        <span class={'sa-auteur-pane-handled-text'}>{row.original}</span>
                                                                        <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'} {'sa-auteur-pane-handled-caret'}" aria-hidden="true"></i>
                                                                    </button>
                                                                    {#if isExpanded}
                                                                        <div class={'sa-auteur-pane-handled-detail'}>
                                                                            <div class={'sa-auteur-pane-diff-block'}>
                                                                                <div class={'sa-auteur-pane-diff-row'}>
                                                                                    <span class={'sa-auteur-pane-diff-label'}>Origineel</span>
                                                                                    <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--removed'}">{row.original}</span>
                                                                                </div>
                                                                                {#if wasAccepted && entry?.appliedText}
                                                                                    <div class={'sa-auteur-pane-diff-row'}>
                                                                                        <span class={'sa-auteur-pane-diff-label'}>Vervangen door</span>
                                                                                        <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--added'}">{entry.appliedText}</span>
                                                                                    </div>
                                                                                {/if}
                                                                            </div>
                                                                            {#if wasAccepted}
                                                                                <button
                                                                                    type="button"
                                                                                    class={'sa-auteur-pane-btn-undo-suggestion'}
                                                                                    on:click|stopPropagation={() => onUndoSuggestion(row.id)}
                                                                                >
                                                                                    Ongedaan maken
                                                                                </button>
                                                                            {/if}
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        {/if}
                                                    {/if}
                                                {:else}
                                                    <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                        {parsed}
                                                    </div>
                                                {/if}
                                            {:else}
                                                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                    {nota.chapterFeedbacksB1[guideline.id]}
                                                </div>
                                            {/if}
                                        </div>
                                    </div>
                                {/if}
                            {/each}
                        </div>
                    </div>
                {:else}
                    <div style="text-align: center; padding: 60px 20px; color: var(--sa-text-muted)">
                        <i class="ph-bold ph-info" style="font-size: 2rem; display: block; margin-bottom: 12px; opacity: 0.2"></i>
                        Geen Direct Duidelijk-feedback gevonden. Klik op het <i class="ph-bold ph-sparkle"></i> icoon in de editor om de AI te starten.
                    </div>
                {/if}
            </div>
        {:else if activeTab === 'woordenlijst'}
            <div class="tm-overview-section">
                <div class="tm-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px">
                    <h3 style="font-size: 1.1rem; font-weight: 700; color: {COLOR_WOORDENLIJST}; display: flex; align-items: center; gap: 8px; margin: 0">
                        <i class="ph-bold ph-text-aa"></i> Woordenlijst
                    </h3>
                    <button
                        type="button"
                        class="sa-btn sa-btn-primary"
                        style="background: {COLOR_WOORDENLIJST}; color: var(--sa-bg-panel); border: none"
                        disabled={!activeBlockId || isActiveBlockWorkflowDone || !isActiveBlockAiToolsEnabled || blocksAnalyzing.has(activeBlockId)}
                        on:click={() => {
                            const g = templateGuidelines.find((x) => `block-${x.id}` === activeBlockId);
                            if (g) ontriggerWoordenlijst(activeBlockId, g.id);
                        }}
                    >
                        <i class="ph-bold ph-text-aa"></i> Controleer woordenlijst
                    </button>
                </div>
                <p style="font-size: 0.82rem; color: var(--sa-text-muted); margin: 0 0 16px 0">
                    Controle op woordniveau (B1, vaag, jargon). Twee alternatieven per woord waar nodig.
                </p>
                {#if nota.chapterFeedbacksWoordenlijst && Object.keys(nota.chapterFeedbacksWoordenlijst).length > 0}
                    <div class="consolidated-feedback-section">
                        <div style="display: flex; flex-direction: column; gap: 20px">
                            {#each (activeBlockId ? templateGuidelines.filter(g => `block-${g.id}` === activeBlockId) : templateGuidelines) as guideline}
                                {#if nota?.chapterFeedbacksWoordenlijst && nota.chapterFeedbacksWoordenlijst[guideline.id]}
                                    <div class="chapter-feedback-card" style="background: var(--sa-bg-panel); border: 1px solid var(--sa-border-color); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.02)">
                                        <div style="padding: 10px 14px; background: var(--sa-bg-sidebar); border-bottom: 1px solid var(--sa-border-color); font-weight: 700; font-size: 0.8rem; color: {COLOR_WOORDENLIJST}; display: flex; align-items: center; gap: 8px">
                                            <span class="idx" style="background: {COLOR_WOORDENLIJST}; color: var(--sa-bg-panel); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem">{guideline.id}</span>
                                            {guideline.titel}
                                        </div>
                                        <div style="padding: 14px; display: flex; flex-direction: column; gap: 10px">
                                            {#if parseAiResponse(nota.chapterFeedbacksWoordenlijst[guideline.id])}
                                                {@const parsedW = parseAiResponse(nota.chapterFeedbacksWoordenlijst[guideline.id])}
                                                {#if typeof parsedW === 'object' && !Array.isArray(parsedW)}
                                                    {#if parsedW.FOUT}
                                                        <div class="feedback-pair" style="border-left: 3px solid var(--sa-color-red); background: rgba(239, 68, 68, 0.05); padding: 10px; border-radius: 6px;">
                                                            <div style="font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--sa-color-red-text); margin-bottom: 4px; letter-spacing: 0.05em">
                                                                <i class="ph-bold ph-warning-circle"></i> Validatie Fout
                                                            </div>
                                                            <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-color-red-text); font-weight: 500">
                                                                {parsedW.FOUT}
                                                            </div>
                                                        </div>
                                                    {:else}
                                                        {@const blockIdWl = `block-${guideline.id}`}
                                                        {@const plainWl = getActiveCellText(blockIdWl, content)}
                                                        {@const allWlRows = filterSuggestionsByWorkflow(feedbackToSuggestions(
                                                            parsedW,
                                                            blockIdWl,
                                                            guideline.id,
                                                            'agent_woordenlijst',
                                                            plainWl
                                                        ), guideline.id)}
                                                        {@const wlActive = allWlRows.filter(s => !dismissedSuggestionIds.has(s.id))}
                                                        {@const wlHandled = allWlRows.filter(s => dismissedSuggestionIds.has(s.id))}
                                                        {#if wlActive.length > 0}
                                                            {#each wlActive as row (row.id)}
                                                                {@const isExpanded = expandedSuggestionIds.has(row.id) || $activeSuggestionStore?.highlightId === row.id}
                                                                {@const isHovered = $hoveredSuggestionStore?.id === row.id}
                                                                {@const borderColorWl = $activeSuggestionStore?.highlightId === row.id ? COLOR_WOORDENLIJST : (isHovered ? 'rgba(155, 89, 182, 0.55)' : 'var(--sa-border-color)')}
                                                                <div
                                                                    role="button"
                                                                    tabindex="0"
                                                                    data-sidebar-suggestion-id={row.id}
                                                                    class="feedback-pair"
                                                                    style="border: 1px solid {borderColorWl}; border-radius: 8px; margin-bottom: 12px; cursor: pointer; background: var(--sa-bg-panel); overflow: hidden;"
                                                                    on:mouseenter={() => hoveredSuggestionStore.set({ id: row.id, source: 'tab' })}
                                                                    on:mouseleave={() => hoveredSuggestionStore.set(null)}
                                                                    on:click={() => {
                                                                        if ($activeSuggestionStore?.highlightId === row.id) {
                                                                            activeSuggestionStore.set(null);
                                                                            expandedSuggestionIds = new Set();
                                                                        } else {
                                                                            toggleSuggestion(row.id);
                                                                            handleSidebarSuggestionClick(row.id, blockIdWl);
                                                                        }
                                                                    }}
                                                                    on:keypress={(e) => {
                                                                        if (e.key === 'Enter' || e.key === ' ') {
                                                                            e.preventDefault();
                                                                            if ($activeSuggestionStore?.highlightId === row.id) {
                                                                                activeSuggestionStore.set(null);
                                                                                expandedSuggestionIds = new Set();
                                                                            } else {
                                                                                toggleSuggestion(row.id);
                                                                                handleSidebarSuggestionClick(row.id, blockIdWl);
                                                                            }
                                                                        }
                                                                    }}
                                                                >
                                                                    <div style="padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                                                                        <div style="font-size: 0.88rem; line-height: 1.4; color: var(--sa-text-main); flex: 1;">
                                                                            <span style="font-weight: 700">{row.original || '—'}</span>
                                                                            {#if row.wordCategory}
                                                                                <span style="font-size: 0.65rem; margin-left: 8px; padding: 2px 6px; border-radius: 4px; background: rgba(155, 89, 182, 0.12); color: {COLOR_WOORDENLIJST}; text-transform: uppercase">{row.wordCategory}</span>
                                                                            {/if}
                                                                        </div>
                                                                        <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'}" style="color: var(--sa-text-muted); font-size: 0.9rem; flex-shrink: 0;" aria-hidden="true"></i>
                                                                    </div>
                                                                    {#if isExpanded}
                                                                        <div style="padding: 0 12px 12px 12px; border-top: 1px solid var(--sa-border-color);">
                                                                            {#if row.b1AlternativesIncomplete}
                                                                                <p style="margin: 12px 0 8px; font-size: 0.72rem; color: var(--sa-warn-text); background: var(--sa-color-yellow-bg); border: 1px solid var(--sa-warn-border); border-radius: 6px; padding: 6px 8px; line-height: 1.35">
                                                                                    Minder dan twee alternatieven beschikbaar. Voer de woordenlijst-check opnieuw uit.
                                                                                </p>
                                                                            {/if}
                                                                            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                                                                                {#each row.alternatives || [] as alt, altIdx}
                                                                                    <div style="background: var(--sa-color-purple-bg); border: 1px solid var(--sa-purple-border); border-radius: 8px; overflow: hidden">
                                                                                        <div style="padding: 5px 10px; border-bottom: 1px solid var(--sa-purple-border); font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: {COLOR_WOORDENLIJST}; display: flex; align-items: center; gap: 4px">
                                                                                            <i class="ph-bold ph-check-circle" style="font-size: 0.75rem"></i> Alternatief {altIdx + 1}
                                                                                        </div>
                                                                                        <div style="padding: 8px 10px; font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main); background: var(--sa-bg-panel); border-left: 3px solid var(--sa-color-purple)">
                                                                                            {alt.tekst}
                                                                                        </div>
                                                                                        {#if alt.uitleg}
                                                                                            <div style="padding: 7px 10px; border-top: 1px solid var(--sa-purple-border); border-radius: 6px; font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45; background: var(--sa-color-purple-bg)">
                                                                                                {alt.uitleg}
                                                                                            </div>
                                                                                        {/if}
                                                                                    </div>
                                                                                {/each}
                                                                            </div>
                                                                            <div style="text-align: center; margin-top: 10px; font-size: 0.68rem; color: var(--sa-text-muted);">
                                                                                klik om in tekst te markeren
                                                                            </div>
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        {:else if parsedW.Suggesties && Array.isArray(parsedW.Suggesties) && parsedW.Suggesties.length === 0}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Geen woordenlijst-suggesties in dit antwoord (lege lijst).
                                                            </div>
                                                        {:else if !parsedW.Suggesties || !Array.isArray(parsedW.Suggesties)}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Ongeldig antwoord. Voer de woordenlijst-check opnieuw uit (alleen JSON met <code>Suggesties</code>).
                                                            </div>
                                                        {:else if wlHandled.length === 0}
                                                            <div style="font-size: 0.88rem; color: var(--sa-text-muted); line-height: 1.5">
                                                                Geen openstaande woordenlijst-suggesties.
                                                            </div>
                                                        {/if}
                                                        {#if wlHandled.length > 0}
                                                            {#each wlHandled as row (row.id)}
                                                                {@const wasAccepted = row.id in acceptedSuggestions}
                                                                {@const entry = acceptedSuggestions[row.id]}
                                                                {@const isExpanded = expandedHandledIds.has(row.id)}
                                                                <div class={'sa-auteur-pane-sidebar-row--handled'} data-sidebar-suggestion-id={row.id}>
                                                                    <button
                                                                        class={'sa-auteur-pane-handled-header'}
                                                                        on:click={() => toggleHandledRow(row.id)}
                                                                        aria-expanded={isExpanded}
                                                                    >
                                                                        <span class={'sa-auteur-pane-handled-label'}>{wasAccepted ? 'Geaccepteerd' : 'Afgewezen'}</span>
                                                                        <span class={'sa-auteur-pane-handled-text'}>{row.original}</span>
                                                                        <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'} {'sa-auteur-pane-handled-caret'}" aria-hidden="true"></i>
                                                                    </button>
                                                                    {#if isExpanded}
                                                                        <div class={'sa-auteur-pane-handled-detail'}>
                                                                            <div class={'sa-auteur-pane-diff-block'}>
                                                                                <div class={'sa-auteur-pane-diff-row'}>
                                                                                    <span class={'sa-auteur-pane-diff-label'}>Origineel</span>
                                                                                    <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--removed'}">{row.original}</span>
                                                                                </div>
                                                                                {#if wasAccepted && entry?.appliedText}
                                                                                    <div class={'sa-auteur-pane-diff-row'}>
                                                                                        <span class={'sa-auteur-pane-diff-label'}>Vervangen door</span>
                                                                                        <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--added'}">{entry.appliedText}</span>
                                                                                    </div>
                                                                                {/if}
                                                                            </div>
                                                                            {#if wasAccepted}
                                                                                <button
                                                                                    type="button"
                                                                                    class={'sa-auteur-pane-btn-undo-suggestion'}
                                                                                    on:click|stopPropagation={() => onUndoSuggestion(row.id)}
                                                                                >
                                                                                    Ongedaan maken
                                                                                </button>
                                                                            {/if}
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        {/if}
                                                    {/if}
                                                {:else}
                                                    <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                        {parsedW}
                                                    </div>
                                                {/if}
                                            {:else}
                                                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main)">
                                                    {nota.chapterFeedbacksWoordenlijst[guideline.id]}
                                                </div>
                                            {/if}
                                        </div>
                                    </div>
                                {/if}
                            {/each}
                        </div>
                    </div>
                {:else}
                    <div style="text-align: center; padding: 48px 20px; color: var(--sa-text-muted)">
                        <i class="ph-bold ph-text-aa" style="font-size: 2rem; display: block; margin-bottom: 12px; opacity: 0.25"></i>
                        Nog geen woordenlijst-feedback. Kies een hoofdstuk en klik op <strong>Controleer woordenlijst</strong>.
                    </div>
                {/if}
            </div>

        {:else if activeTab === 'spelling'}
            <div class="tm-overview-section">
                <div class="tm-section-header" style="display: flex; align-items: center; margin-bottom: 24px">
                    <h3 style="font-size: 1.1rem; font-weight: 700; color: {COLOR_SPELLING}; display: flex; align-items: center; gap: 8px; margin: 0">
                        <i class="ph-bold ph-spell-check"></i> Spelling, grammatica en leestekens
                    </h3>
                </div>

                {#if (nota.chapterFeedbacksSpelling && Object.keys(nota.chapterFeedbacksSpelling).length > 0) || spellingFeedbackCount > 0}
                    <div class="consolidated-feedback-section">
                        <div style="display: flex; flex-direction: column; gap: 20px">
                            {#each (activeBlockId ? templateGuidelines.filter(g => `block-${g.id}` === activeBlockId) : templateGuidelines) as guideline}
                                {#if (nota?.chapterFeedbacksSpelling && nota.chapterFeedbacksSpelling[guideline.id]) || mergedSpellingRowsForChapter(guideline.id).length > 0}
                                    <div class="chapter-feedback-card" style="background: var(--sa-bg-panel); border: 1px solid var(--sa-border-color); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.02)">
                                        <div style="padding: 10px 14px; background: var(--sa-bg-sidebar); border-bottom: 1px solid var(--sa-border-color); font-weight: 700; font-size: 0.8rem; color: {COLOR_SPELLING}; display: flex; align-items: center; gap: 8px">
                                            <span class="idx" style="background: {COLOR_SPELLING}; color: var(--sa-bg-panel); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem">{guideline.id}</span>
                                            {guideline.titel}
                                        </div>
                                        <div style="padding: 14px; display: flex; flex-direction: column; gap: 10px">
                                            {#if nota?.chapterFeedbacksSpelling?.[guideline.id] && parseAiResponse(nota.chapterFeedbacksSpelling[guideline.id])}
                                                {@const sp = parseAiResponse(nota.chapterFeedbacksSpelling[guideline.id])}
                                                {#if typeof sp === 'object' && !Array.isArray(sp) && sp.FOUT}
                                                    <div class="feedback-pair" style="border-left: 3px solid var(--sa-color-red); background: rgba(239, 68, 68, 0.05); padding: 10px; border-radius: 6px">
                                                        <div style="font-size: 0.88rem; color: var(--sa-color-red-text)">{sp.FOUT}</div>
                                                    </div>
                                                {:else if typeof sp === 'object' && !Array.isArray(sp)}
                                                    {@const blockIdSp = `block-${guideline.id}`}
                                                    {@const allSpellingRows = filterSuggestionsByWorkflow(mergedSpellingRowsForChapter(guideline.id), guideline.id)}
                                                    {@const spellingActive = allSpellingRows.filter(s => !dismissedSuggestionIds.has(s.id))}
                                                    {@const spellingHandled = allSpellingRows.filter(s => dismissedSuggestionIds.has(s.id))}
                                                    {#each spellingActive as row (row.id)}
                                                        {@const isExpanded = expandedSuggestionIds.has(row.id) || $activeSuggestionStore?.highlightId === row.id}
                                                        {@const isHovered = $hoveredSuggestionStore?.id === row.id}
                                                        {@const borderColor = $activeSuggestionStore?.highlightId === row.id ? 'var(--sa-spelling-text)' : (isHovered ? 'rgba(16, 185, 129, 0.5)' : 'var(--sa-border-color)')}
                                                        <div
                                                            role="button"
                                                            tabindex="0"
                                                            data-sidebar-suggestion-id={row.id}
                                                            class="feedback-pair"
                                                            style="border: 1px solid {borderColor}; border-radius: 8px; margin-bottom: 12px; cursor: pointer; background: var(--sa-bg-panel); overflow: hidden;"
                                                            on:mouseenter={() => hoveredSuggestionStore.set({ id: row.id, source: 'tab' })}
                                                            on:mouseleave={() => hoveredSuggestionStore.set(null)}
                                                            on:click={() => {
                                                                if ($activeSuggestionStore?.highlightId === row.id) {
                                                                    // Already active - close it
                                                                    activeSuggestionStore.set(null);
                                                                    expandedSuggestionIds = new Set();
                                                                } else {
                                                                    toggleSuggestion(row.id);
                                                                    handleSidebarSuggestionClick(row.id, blockIdSp);
                                                                }
                                                            }}
                                                            on:keypress={(e) => {
                                                                if (e.key === 'Enter' || e.key === ' ') {
                                                                    e.preventDefault();
                                                                    if ($activeSuggestionStore?.highlightId === row.id) {
                                                                        activeSuggestionStore.set(null);
                                                                        expandedSuggestionIds = new Set();
                                                                    } else {
                                                                        toggleSuggestion(row.id);
                                                                        handleSidebarSuggestionClick(row.id, blockIdSp);
                                                                    }
                                                                }
                                                            }}
                                                        >
                                                            <!-- Clickable header -->
                                                            <div style="padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                                                                <div style="font-size: 0.88rem; line-height: 1.4; color: var(--sa-text-main); flex: 1;">
                                                                    {suggestionDisplayText(row.original, row.explanation)}
                                                                </div>
                                                                <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'}" style="color: var(--sa-text-muted); font-size: 0.9rem; flex-shrink: 0;" aria-hidden="true"></i>
                                                            </div>

                                                            {#if isExpanded}
                                                                <div style="padding: 0 12px 12px 12px; border-top: 1px solid var(--sa-border-color);">
                                                                    {#if row.suggested}
                                                                        <!-- Voorstel -->
                                                                        <div style="background: var(--sa-ok-bg); border: 1px solid var(--sa-ok-border); border-radius: 8px; overflow: hidden; margin-top: 12px;">
                                                                            <div style="padding: 5px 10px; border-bottom: 1px solid var(--sa-ok-border); font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sa-ok-text); display: flex; align-items: center; gap: 4px">
                                                                                <i class="ph-bold ph-check-circle" style="font-size: 0.75rem"></i> Voorstel
                                                                            </div>
                                                                            <div style="padding: 8px 10px; font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main); background: var(--sa-bg-panel); border-left: 3px solid var(--sa-ok-accent)">
                                                                                {suggestionDisplayText(row.suggested, row.explanation)}
                                                                            </div>
                                                                            {#if row.explanation && row.suggested.trim()}
                                                                                <div style="padding: 7px 10px; border-top: 1px solid var(--sa-ok-border); font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45; background: var(--sa-ok-bg)">
                                                                                    {row.explanation}
                                                                                </div>
                                                                            {/if}
                                                                        </div>
                                                                    {:else if row.explanation}
                                                                        <div style="margin-top: 12px; font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45">{row.explanation}</div>
                                                                    {/if}
                                                                    {#if row.ruleDetails && row.ruleDetails.length}
                                                                        {#each row.ruleDetails as rd}
                                                                            <div style="font-size: 0.68rem; margin-top: 8px; color: var(--sa-text-muted)">
                                                                                <strong>{rd.key}:</strong> {rd.text}
                                                                            </div>
                                                                        {/each}
                                                                    {/if}
                                                                    {#if row.handbookSnippet}
                                                                        <div style="font-size: 0.72rem; margin-top: 8px; color: var(--sa-text-muted); font-style: italic; border-left: 2px solid rgba(16, 185, 129, 0.4); padding-left: 8px">
                                                                            <strong style="font-style: normal">Bron:</strong> {row.handbookSnippet}
                                                                        </div>
                                                                    {/if}
                                                                    {#if row.referenceLinks && row.referenceLinks.length}
                                                                        <div style="font-size: 0.72rem; margin-top: 8px; display: flex; flex-direction: column; gap: 4px">
                                                                            <span style="font-weight: 700; color: var(--sa-text-muted); text-transform: uppercase; font-size: 0.65rem">Hulplijnen</span>
                                                                            {#each row.referenceLinks as rlink}
                                                                                {#if safeLinkUrl(rlink.url)}<a href={safeLinkUrl(rlink.url)} target="_blank" rel="noopener noreferrer" style="color: {COLOR_SPELLING}; text-decoration: underline" on:click|stopPropagation>{rlink.label}</a>{:else}<span>{rlink.label}</span>{/if}
                                                                            {/each}
                                                                        </div>
                                                                    {/if}

                                                                    <!-- Hint at bottom -->
                                                                    <div style="text-align: center; margin-top: 10px; font-size: 0.68rem; color: var(--sa-text-muted);">
                                                                        klik om in tekst te markeren
                                                                    </div>
                                                                </div>
                                                            {/if}
                                                        </div>
                                                    {/each}
                                                    {#each spellingHandled as row (row.id)}
                                                        {@const wasAccepted = row.id in acceptedSuggestions}
                                                        {@const entry = acceptedSuggestions[row.id]}
                                                        {@const isExpanded = expandedHandledIds.has(row.id)}
                                                        <div class={'sa-auteur-pane-sidebar-row--handled'} data-sidebar-suggestion-id={row.id}>
                                                            <button
                                                                class={'sa-auteur-pane-handled-header'}
                                                                on:click={() => toggleHandledRow(row.id)}
                                                                aria-expanded={isExpanded}
                                                            >
                                                                <span class={'sa-auteur-pane-handled-label'}>{wasAccepted ? 'Geaccepteerd' : 'Afgewezen'}</span>
                                                                <span class={'sa-auteur-pane-handled-text'}>{suggestionDisplayText(row.original, row.explanation)}</span>
                                                                <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'} {'sa-auteur-pane-handled-caret'}" aria-hidden="true"></i>
                                                            </button>
                                                            {#if isExpanded}
                                                                <div class={'sa-auteur-pane-handled-detail'}>
                                                                    <div class={'sa-auteur-pane-diff-block'}>
                                                                        <div class={'sa-auteur-pane-diff-row'}>
                                                                            <span class={'sa-auteur-pane-diff-label'}>Origineel</span>
                                                                            <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--removed'}">{row.original}</span>
                                                                        </div>
                                                                        {#if wasAccepted && entry?.appliedText}
                                                                            <div class={'sa-auteur-pane-diff-row'}>
                                                                                <span class={'sa-auteur-pane-diff-label'}>Vervangen door</span>
                                                                                <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--added'}">{entry.appliedText}</span>
                                                                            </div>
                                                                        {/if}
                                                                    </div>
                                                                    {#if wasAccepted}
                                                                        <button
                                                                            type="button"
                                                                            class={'sa-auteur-pane-btn-undo-suggestion'}
                                                                            on:click|stopPropagation={() => onUndoSuggestion(row.id)}
                                                                        >
                                                                            Ongedaan maken
                                                                        </button>
                                                                    {/if}
                                                                </div>
                                                            {/if}
                                                        </div>
                                                    {/each}
                                                    {#if allSpellingRows.length === 0}
                                                        <div style="font-size: 0.88rem; color: var(--sa-text-muted)">
                                                            {#if Array.isArray(sp.matches)}
                                                                Opgeslagen taalreview is verouderd. Voer de controle opnieuw uit.
                                                            {:else}
                                                                Geen extra meldingen voor deze tekst. Tip: gebruik ook de rode/groene onderstreping in het veld (browser) ter controle.
                                                            {/if}
                                                        </div>
                                                    {:else if spellingActive.length === 0 && spellingHandled.length === 0}
                                                        <div style="font-size: 0.88rem; color: var(--sa-text-muted)">
                                                            Geen openstaande taalmeldingen (alles afgehandeld).
                                                        </div>
                                                    {/if}
                                                {:else}
                                                    <div style="font-size: 0.88rem; color: var(--sa-text-main)">{JSON.stringify(sp)}</div>
                                                {/if}
                                            {:else}
                                                {@const blockIdSpOnly = `block-${guideline.id}`}
                                                {@const allSpellingRows = filterSuggestionsByWorkflow(mergedSpellingRowsForChapter(guideline.id), guideline.id)}
                                                {@const spellingActive = allSpellingRows.filter(s => !dismissedSuggestionIds.has(s.id))}
                                                {@const spellingHandled = allSpellingRows.filter(s => dismissedSuggestionIds.has(s.id))}
                                                {#each spellingActive as row (row.id)}
                                                    {@const isHovered = $hoveredSuggestionStore?.id === row.id}
                                                    {@const borderColor = $activeSuggestionStore?.highlightId === row.id ? 'var(--sa-spelling-text)' : (isHovered ? 'rgba(16, 185, 129, 0.5)' : 'var(--sa-border-color)')}
                                                    <div
                                                        role="button"
                                                        tabindex="0"
                                                        data-sidebar-suggestion-id={row.id}
                                                        class="feedback-pair"
                                                        style="border: 1px solid {borderColor}; border-radius: 10px; margin-bottom: 14px; cursor: pointer; background: var(--sa-bg-panel); box-shadow: 0 2px 6px rgba(0,0,0,0.06); overflow: hidden;"
                                                        on:mouseenter={() => hoveredSuggestionStore.set({ id: row.id, source: 'tab' })}
                                                        on:mouseleave={() => hoveredSuggestionStore.set(null)}
                                                        on:click={() =>
                                                            handleSidebarSuggestionClick(row.id, blockIdSpOnly)}
                                                        on:keypress={(e) => {
                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                e.preventDefault();
                                                                handleSidebarSuggestionClick(row.id, blockIdSpOnly);
                                                            }
                                                        }}
                                                    >
                                                        <!-- Card header -->
                                                        <div style="padding: 7px 12px; background: var(--sa-bg-sidebar); border-bottom: 1px solid var(--sa-border-color); display: flex; align-items: center; gap: 8px">
                                                            <i class="ph-bold ph-spell-check" style="color: var(--sa-spelling-text); font-size: 0.85rem"></i>
                                                            <span style="font-size: 0.7rem; font-weight: 700; color: var(--sa-text-muted); text-transform: uppercase; letter-spacing: 0.05em">Taalreview</span>
                                                            <span style="margin-left: auto; font-size: 0.65rem; color: var(--sa-text-muted)">klik om te markeren</span>
                                                        </div>
                                                        <div style="padding: 12px">
                                                            <!-- Gevonden -->
                                                            <div style="margin-bottom: 8px">
                                                                <div style="font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sa-color-red-text); margin-bottom: 4px; display: flex; align-items: center; gap: 4px">
                                                                    <i class="ph-bold ph-x-circle" style="font-size: 0.75rem"></i> Gevonden
                                                                </div>
                                                                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main); background: var(--sa-color-red-bg); padding: 8px 10px; border-radius: 6px; border-left: 3px solid var(--sa-color-red)">
                                                                    {suggestionDisplayText(row.original, row.explanation)}
                                                                </div>
                                                            </div>
                                                            {#if row.suggested}
                                                                <!-- Arrow -->
                                                                <div style="text-align: center; color: var(--sa-text-muted); font-size: 1rem; margin: 4px 0">
                                                                    <i class="ph-bold ph-arrow-down"></i>
                                                                </div>
                                                                <!-- Voorstel -->
                                                                <div style="background: var(--sa-ok-bg); border: 1px solid var(--sa-ok-border); border-radius: 8px; overflow: hidden">
                                                                    <div style="padding: 5px 10px; border-bottom: 1px solid var(--sa-ok-border); font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sa-ok-text); display: flex; align-items: center; gap: 4px">
                                                                        <i class="ph-bold ph-check-circle" style="font-size: 0.75rem"></i> Voorstel
                                                                    </div>
                                                                    <div style="padding: 8px 10px; font-size: 0.88rem; line-height: 1.5; color: var(--sa-text-main); background: var(--sa-bg-panel); border-left: 3px solid var(--sa-ok-accent)">
                                                                        {suggestionDisplayText(row.suggested, row.explanation)}
                                                                    </div>
                                                                    {#if row.explanation && row.suggested.trim()}
                                                                        <div style="padding: 7px 10px; border-top: 1px solid var(--sa-ok-border); font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45; background: var(--sa-ok-bg)">
                                                                            <span style="font-weight: 700; text-transform: uppercase; font-size: 0.62rem; letter-spacing: 0.05em; display: block; margin-bottom: 2px; color: var(--sa-ok-text)">Uitleg</span>
                                                                            {row.explanation}
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                            {:else if row.explanation}
                                                                <div style="margin-top: 6px; font-size: 0.78rem; color: var(--sa-text-muted); line-height: 1.45">{row.explanation}</div>
                                                            {/if}
                                                        </div>
                                                    </div>
                                                {/each}
                                                {#each spellingHandled as row (row.id)}
                                                    {@const wasAccepted = row.id in acceptedSuggestions}
                                                    {@const entry = acceptedSuggestions[row.id]}
                                                    {@const isExpanded = expandedHandledIds.has(row.id)}
                                                    <div class={'sa-auteur-pane-sidebar-row--handled'} data-sidebar-suggestion-id={row.id}>
                                                        <button
                                                            class={'sa-auteur-pane-handled-header'}
                                                            on:click={() => toggleHandledRow(row.id)}
                                                            aria-expanded={isExpanded}
                                                        >
                                                            <span class={'sa-auteur-pane-handled-label'}>{wasAccepted ? 'Geaccepteerd' : 'Afgewezen'}</span>
                                                            <span class={'sa-auteur-pane-handled-text'}>{suggestionDisplayText(row.original, row.explanation)}</span>
                                                            <i class="ph {isExpanded ? 'ph-caret-up' : 'ph-caret-down'} {'sa-auteur-pane-handled-caret'}" aria-hidden="true"></i>
                                                        </button>
                                                        {#if isExpanded}
                                                            <div class={'sa-auteur-pane-handled-detail'}>
                                                                <div class={'sa-auteur-pane-diff-block'}>
                                                                    <div class={'sa-auteur-pane-diff-row'}>
                                                                        <span class={'sa-auteur-pane-diff-label'}>Origineel</span>
                                                                        <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--removed'}">{row.original}</span>
                                                                    </div>
                                                                    {#if wasAccepted && entry?.appliedText}
                                                                        <div class={'sa-auteur-pane-diff-row'}>
                                                                            <span class={'sa-auteur-pane-diff-label'}>Vervangen door</span>
                                                                            <span class="{'sa-auteur-pane-diff-text'} {'sa-auteur-pane-diff-text--added'}">{entry.appliedText}</span>
                                                                        </div>
                                                                    {/if}
                                                                </div>
                                                                {#if wasAccepted}
                                                                    <button
                                                                        type="button"
                                                                        class={'sa-auteur-pane-btn-undo-suggestion'}
                                                                        on:click|stopPropagation={() => onUndoSuggestion(row.id)}
                                                                    >
                                                                        Ongedaan maken
                                                                    </button>
                                                                {/if}
                                                            </div>
                                                        {/if}
                                                    </div>
                                                {/each}
                                            {/if}
                                        </div>
                                    </div>
                                {/if}
                            {/each}
                        </div>
                    </div>
                {:else}
                    <div style="text-align: center; padding: 60px 20px; color: var(--sa-text-muted)">
                        <i class="ph-bold ph-spell-check" style="font-size: 2rem; display: block; margin-bottom: 12px; opacity: 0.2"></i>
                        Nog geen taalreview. Klik op <i class="ph-bold ph-sparkle"></i> <strong>AI analyse</strong> bij een hoofdstuk in de editor om spelling, grammatica en leestekens te laten controleren.
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</section>
