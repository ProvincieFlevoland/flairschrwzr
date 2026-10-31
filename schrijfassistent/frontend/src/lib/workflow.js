/**
 * Per-chapter workflow: Concept → Review → Klaar (`done` in storage).
 * Used by Workspace, strip UI, and server validation (mirrored in Python).
 */

/** @typedef {'concept' | 'review' | 'done'} BlockWorkflowState */

/** Values persisted under `nota.blockWorkflow[blockId]`. */
export const BLOCK_WORKFLOW_STATES = /** @type {const} */ (['concept', 'review', 'done']);

const VALID = new Set(BLOCK_WORKFLOW_STATES);

/**
 * @param {unknown} raw
 * @returns {BlockWorkflowState}
 */
export function normalizeBlockWorkflowState(raw) {
    // Legacy 'ai' state is treated as 'concept' (AI is now always available in concept).
    if (raw === 'ai') return 'concept';
    if (raw === 'review' || raw === 'done') return raw;
    return 'concept';
}

/**
 * @param {unknown} obj
 * @returns {Record<string, BlockWorkflowState>}
 */
export function normalizeBlockWorkflowMap(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    /** @type {Record<string, BlockWorkflowState>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = normalizeBlockWorkflowState(v);
    }
    return out;
}

/**
 * @param {Record<string, BlockWorkflowState>} map
 * @param {string} blockId
 */
export function isWorkflowLocked(map, blockId) {
    return map[blockId] === 'done';
}

/**
 * AI and spelling tools are available in concept (draft) mode.
 * @param {Record<string, BlockWorkflowState>} map
 * @param {string} blockId
 */
export function isWorkflowAiEnabled(map, blockId) {
    return map[blockId] !== 'done';
}

/**
 * Dutch label for UI (strip, pills, aria).
 * @param {unknown} state
 */
export function workflowPhaseLabelNl(state) {
    switch (normalizeBlockWorkflowState(state)) {
        case 'concept':
            return 'Concept';
        case 'review':
            return 'Review';
        case 'done':
            return 'Klaar';
        default:
            return 'Concept';
    }
}

/**
 * @param {unknown} v
 * @returns {v is BlockWorkflowState}
 */
export function isValidBlockWorkflowState(v) {
    return typeof v === 'string' && VALID.has(/** @type {string} */ (v));
}
