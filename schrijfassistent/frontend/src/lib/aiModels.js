/**
 * Model choice per configuratie, kop and opdracht: the pure helpers of the configurator (AdminDashboard.svelte).
 *
 * The configuration (metadata.json) and every kop (hoofdstukken/<id>.json) can hold the same block:
 *
 *   aiModellen: { standaard: '<model>', opdrachten: { agent_spelling_grammatica: '<model>', titel: '<model>', ... } }
 *
 * Empty or missing means "overnemen van het niveau erboven". The backend (app/core/model_resolver.py) picks the most
 * specific choice: kop-opdracht, kop, configuratie-opdracht, configuratie, and otherwise AI_MODEL (the system default).
 * `effectiveModel` below is the same order, so the configurator shows the model that will be used.
 */

export const MODELS_KEY = 'aiModellen';
const DEFAULT_KEY = 'standaard';
const TASKS_KEY = 'opdrachten';

/** The opdrachten the Schrijfassistent runs per kop (Workspace.svelte `triggerAiAnalysis`). */
export const CHAPTER_MODEL_TASKS = [
    { key: 'agent_structuur', label: 'Structuur' },
    { key: 'agent_spelling_grammatica', label: 'Spelling' },
    { key: 'agent_b1', label: 'Direct Duidelijk' },
    { key: 'agent_woordenlijst', label: 'Woordenlijst' },
];

/** The opdrachten that apply to the whole nota (no kop): only chosen on the configuration. */
export const NOTA_MODEL_TASKS = [
    { key: 'titel', label: 'Titel van de nota' },
    { key: 'samenvatting', label: 'Samenvatting van de nota' },
];

/**
 * A filled-in model choice, or null for empty, missing or not text.
 * @param {unknown} v
 * @returns {string | null}
 */
export function modelChoice(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** @param {any} holder */
function blockOf(holder) {
    const block = holder && typeof holder === 'object' ? holder[MODELS_KEY] : null;
    return block && typeof block === 'object' && !Array.isArray(block) ? block : null;
}

/**
 * The stored choice of a configuration or kop: its standaard (`task` null) or the choice for one opdracht. '' when none.
 * @param {any} holder
 * @param {string | null} task
 */
export function getChoice(holder, task) {
    const block = blockOf(holder);
    if (!block) return '';
    if (task == null) return modelChoice(block[DEFAULT_KEY]) || '';
    const tasks = block[TASKS_KEY];
    return (tasks && typeof tasks === 'object' && !Array.isArray(tasks) && modelChoice(tasks[task])) || '';
}

/**
 * Sets (or with '' clears) a choice on a configuration or kop. Empty entries are removed, and an empty block is removed
 * altogether, so a configuration without choices is saved exactly as before. Mutates `holder`.
 * @param {any} holder
 * @param {string | null} task
 * @param {string} value
 */
export function setChoice(holder, task, value) {
    if (!holder || typeof holder !== 'object') return;
    const model = modelChoice(value);
    const block = { ...(blockOf(holder) || {}) };
    if (task == null) {
        if (model) block[DEFAULT_KEY] = model;
        else delete block[DEFAULT_KEY];
    } else {
        const tasks = { ...(block[TASKS_KEY] && typeof block[TASKS_KEY] === 'object' ? block[TASKS_KEY] : {}) };
        if (model) tasks[task] = model;
        else delete tasks[task];
        if (Object.keys(tasks).length) block[TASKS_KEY] = tasks;
        else delete block[TASKS_KEY];
    }
    const cleaned = cleanModelsBlock(block);
    if (cleaned) holder[MODELS_KEY] = cleaned;
    else delete holder[MODELS_KEY];
}

/**
 * The block without empty entries, or undefined when nothing is chosen.
 * @param {unknown} block
 * @returns {{ standaard?: string, opdrachten?: Record<string, string> } | undefined}
 */
export function cleanModelsBlock(block) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
    /** @type {any} */
    const out = {};
    const def = modelChoice(/** @type {any} */ (block)[DEFAULT_KEY]);
    if (def) out[DEFAULT_KEY] = def;
    const tasks = /** @type {any} */ (block)[TASKS_KEY];
    if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
        const kept = Object.fromEntries(
            Object.entries(tasks).map(([k, v]) => [k, modelChoice(v)]).filter(([, v]) => v)
        );
        if (Object.keys(kept).length) out[TASKS_KEY] = kept;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * The model a call will use and where that choice comes from, in the order of the backend. A choice that is not in
 * `available` (when that list is known) is skipped, like the backend does.
 * @param {string} task
 * @param {any} chapter - the kop, or null for a nota-wide opdracht
 * @param {any} config
 * @param {string} defaultModel - AI_MODEL
 * @param {string[] | null} [available]
 * @returns {{ model: string, source: 'kop-opdracht' | 'kop' | 'configuratie-opdracht' | 'configuratie' | 'standaard' }}
 */
export function effectiveModel(task, chapter, config, defaultModel, available = null) {
    const ok = (m) => m && (!available || available.includes(m));
    /** @type {[any, string, string][]} */
    const levels = [
        [chapter, task, 'kop-opdracht'],
        [chapter, null, 'kop'],
        [config, task, 'configuratie-opdracht'],
        [config, null, 'configuratie'],
    ];
    for (const [holder, t, source] of levels) {
        if (!holder) continue;
        const m = getChoice(holder, t);
        if (ok(m)) return { model: m, source: /** @type {any} */ (source) };
    }
    return { model: defaultModel || '', source: 'standaard' };
}

/**
 * What a level falls back to when it has no choice of its own: the model shown in its "Overnemen (...)" option.
 * (A kop's standaard has no single answer, because the configuration can choose per opdracht; the configurator shows
 * "Overnemen van de configuratie" there.)
 * @param {'kop-opdracht' | 'configuratie-opdracht' | 'configuratie'} level
 * @param {string | null} task - the opdracht (null for 'configuratie')
 * @param {any} chapter - the kop (only for 'kop-opdracht')
 * @param {any} config
 * @param {string} defaultModel
 * @param {string[] | null} [available]
 */
export function inheritedModel(level, task, chapter, config, defaultModel, available = null) {
    if (level === 'kop-opdracht') {
        const kopDefault = getChoice(chapter, null);
        const kop = kopDefault ? { [MODELS_KEY]: { [DEFAULT_KEY]: kopDefault } } : null;
        return effectiveModel(/** @type {string} */ (task), kop, config, defaultModel, available).model;
    }
    if (level === 'configuratie-opdracht') {
        const configDefault = getChoice(config, null);
        const cfg = configDefault ? { [MODELS_KEY]: { [DEFAULT_KEY]: configDefault } } : null;
        return effectiveModel(/** @type {string} */ (task), null, cfg, defaultModel, available).model;
    }
    return defaultModel || '';
}

/**
 * Options of a model list: the models of the AI service, plus a stored choice that is not (or no longer) offered,
 * marked so the beheerder sees it falls back.
 * @param {string[]} available
 * @param {string} current
 * @param {boolean} listKnown - false when the list could not be fetched (then a stored choice is not marked)
 * @returns {{ value: string, label: string, missing: boolean }[]}
 */
export function modelOptions(available, current, listKnown = true) {
    const list = Array.isArray(available) ? available : [];
    const opts = list.map((m) => ({ value: m, label: m, missing: false }));
    if (current && !list.includes(current)) {
        opts.unshift({ value: current, label: listKnown ? `${current} (niet beschikbaar)` : current, missing: listKnown });
    }
    return opts;
}

/**
 * The koppen that have a choice of their own, for the overview on the configuration tab.
 * @param {any[]} chapters
 * @returns {{ id: string, titel: string, choices: string[] }[]}
 */
export function chaptersWithOwnModels(chapters) {
    if (!Array.isArray(chapters)) return [];
    const out = [];
    for (const ch of chapters) {
        const block = cleanModelsBlock(blockOf(ch));
        if (!block) continue;
        const choices = [];
        if (block.standaard) choices.push(`alle opdrachten: ${block.standaard}`);
        for (const t of CHAPTER_MODEL_TASKS) {
            const m = block.opdrachten?.[t.key];
            if (m) choices.push(`${t.label}: ${m}`);
        }
        for (const [k, m] of Object.entries(block.opdrachten || {})) {
            if (!CHAPTER_MODEL_TASKS.some((t) => t.key === k)) choices.push(`${k}: ${m}`);
        }
        out.push({ id: String(ch.id ?? ''), titel: String(ch.titel ?? ''), choices });
    }
    return out;
}

/**
 * The answer of `GET /ai-models`, normalised for the configurator.
 * @param {any} data
 * @returns {{ selectable: boolean, defaultModel: string, models: string[], error: string, provider: string }}
 */
export function normaliseModelInfo(data) {
    const d = data && typeof data === 'object' ? data : {};
    const models = Array.isArray(d.models) ? d.models.filter((m) => typeof m === 'string' && m.trim()) : [];
    return {
        selectable: d.selectable === true,
        defaultModel: typeof d.default === 'string' ? d.default : '',
        models,
        error: typeof d.error === 'string' ? d.error : '',
        provider: typeof d.provider === 'string' ? d.provider : '',
    };
}

/**
 * Which AI opdrachten belong to which onderdeel (tab) of the configurator, so a beheerder chooses the model where the
 * onderdeel is edited. Terminologie, Regels and the B1 metrics are checked in the editor itself, without AI.
 * @type {Record<string, { key: string, label: string }[]>}
 */
export const SECTION_MODEL_TASKS = {
    hoofdstukken: [
        { key: 'agent_structuur', label: 'Structuur' },
        { key: 'agent_spelling_grammatica', label: 'Spelling' },
    ],
    'b1-parameters': [{ key: 'agent_b1', label: 'Direct Duidelijk' }],
    woordenlijst: [{ key: 'agent_woordenlijst', label: 'Woordenlijst' }],
};

/**
 * True when a kop has a model choice of its own.
 * @param {any} chapter
 */
export function hasOwnModels(chapter) {
    return !!cleanModelsBlock(blockOf(chapter));
}

/**
 * Removes every model choice of a configuration or kop (the kop then follows the onderdelen again). Mutates `holder`.
 * @param {any} holder
 */
export function clearChoices(holder) {
    if (holder && typeof holder === 'object') delete holder[MODELS_KEY];
}
