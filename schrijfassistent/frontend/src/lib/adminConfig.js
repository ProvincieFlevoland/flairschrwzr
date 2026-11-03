/**
 * Pure helpers of the configurator. They hold the parts of `AdminDashboard.svelte` that decide what
 * is sent to the backend, what is accepted from a file and what is shown to an auteur, so they can be tested
 * without a DOM.
 */

/** Blob folders that are not configurations. `GET /configurations` hides `notas`; a save under that id would wipe every nota. */
const RESERVED_CONFIG_IDS = ['notas'];
const MAX_CONFIG_ID_LENGTH = 128;

/** Largest configuration file the import accepts. The v5 fixture is 135,647 bytes. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Caps of an imported configuration: the real v5 configuration is 7 levels deep, 15 chapters, 6,144 characters in its longest text. */
export const MAX_IMPORT_DEPTH = 32;
export const MAX_IMPORT_STRING = 50000;
export const MAX_IMPORT_NODES = 200000;
export const MAX_IMPORT_CHAPTERS = 500;
export const MAX_IMPORT_RULES = 2000;

/**
 * What a legitimate id, subfolder name or item id contains: letters, digits, underscore, space, dot and hyphen (`GS-nota v5`, `h1`,
 * `r<ms>`, `conf-<ms>`). The backend guard (`app/core/blob_guard.py`) is the same rule; `\w` there is `[\p{L}\p{N}_]` here.
 */
const SEGMENT = /^[\p{L}\p{N}_ .\-]+$/u;

/**
 * Why a value cannot be a blob path segment (`null` when it can). The same rule as the backend guard, so the toast of the
 * configurator comes before the 400 of the backend. Messages are Dutch; the value itself is never part of the message.
 * @param {unknown} v
 * @returns {string | null}
 */
export function segmentProblem(v) {
    if (typeof v !== 'string') return 'is geen tekst';
    if (v === '') return 'is leeg';
    if (v !== v.trim()) return 'begint of eindigt met een spatie';
    if (v.length > MAX_CONFIG_ID_LENGTH) return `is langer dan ${MAX_CONFIG_ID_LENGTH} tekens`;
    if (/[\\/]/.test(v)) return 'bevat een schuine streep (/ of \\)';
    if (/[?#%]/.test(v)) return 'bevat een ?, # of %';
    if (v === '.' || v === '..' || v.includes('..')) return "bevat '..'";
    if (v.startsWith('.') || v.endsWith('.')) return 'begint of eindigt met een punt';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) return 'bevat stuurtekens';
    if (!SEGMENT.test(v)) return 'bevat een teken dat niet is toegestaan (alleen letters, cijfers, spatie, punt, streepje en underscore)';
    return null;
}

/**
 * The id of a configuration is the blob folder name of `POST /upload-configuration`, which deletes everything under
 * `<id>/` before it rebuilds the folder. Without a check, whatever the "Uniek ID" field held would be sent: an empty
 * id, `notas`, an id with a slash, and `?`, `#` or `%`, which change the target of the DELETE and PATCH requests of
 * the row, reached the backend unchecked.
 * @param {unknown} raw
 * @returns {{ ok: true, id: string } | { ok: false, reason: string }}
 */
export function validateConfigId(raw) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id === '') return { ok: false, reason: 'Het unieke ID van de configuratie mag niet leeg zijn.' };
    const problem = segmentProblem(id);
    if (problem) return { ok: false, reason: `Het unieke ID ${problem}.` };
    if (RESERVED_CONFIG_IDS.includes(id.toLowerCase())) return { ok: false, reason: `Het ID '${id}' is gereserveerd voor opslag van notas.` };
    return { ok: true, id };
}

/**
 * The ids of the items of a configuration (chapter ids, rule ids) become file names under `<id>/<subfolder>/` (`<item id>.json`).
 * An item without an id is filed by its index and is fine. Returns the first problem as a Dutch sentence, or null.
 * @param {Record<string, any>[] | undefined} items
 * @param {string} label
 * @returns {string | null}
 */
export function itemIdProblem(items, label) {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const id = typeof item.id === 'number' && Number.isInteger(item.id) ? String(item.id) : item.id;
        const problem = segmentProblem(id);
        if (problem) return `${label}: het item-id ${JSON.stringify(typeof id === 'string' ? id.slice(0, 40) : String(typeof id))} ${problem}.`;
    }
    return null;
}

/** The first problem with the item ids of a working configuration that is about to be saved, or null. */
export function workingConfigItemProblem(workingConfig) {
    return itemIdProblem(workingConfig.templateGuidelines, 'Hoofdstukken') || itemIdProblem(workingConfig.rules, 'Regels');
}

/**
 * The body of `POST /upload-configuration` for a working copy (`AdminDashboard.saveToStorage`, unchanged).
 * @param {Record<string, any>} workingConfig
 * @param {string} currentId - the trimmed id that becomes the folder key
 */
export function buildUploadPayload(workingConfig, currentId) {
    const payloadInner = {
        name: workingConfig.name,
        templateVersion: workingConfig.templateVersion,
        description: workingConfig.description || '',
        toneOfVoice: workingConfig.toneOfVoice || 'Zakelijk',
        isActive: workingConfig.isActive !== false,
        mappen: {
            hoofdstukken: workingConfig.templateGuidelines || [],
            // Since terminologie/regels are mixed in rules array, filter them out
            terminologie: (workingConfig.rules || []).filter((r) => r.category === 'Terminologie'),
            regels: (workingConfig.rules || []).filter((r) => r.category !== 'Terminologie'),
            woordenlijst: workingConfig.woordenlijst || [],
        },
    };
    if (workingConfig.b1Guidelines !== undefined && workingConfig.b1Guidelines !== null) {
        payloadInner.b1Guidelines = workingConfig.b1Guidelines;
    }
    return { [currentId]: payloadInner };
}

/**
 * True when the bracket nesting of JSON text goes deeper than `max` levels. A scan of the characters outside strings, before
 * `JSON.parse` and before anything is stored: a file nested 900,000 levels deep passed the size limit, parsed, and then made the
 * persistence of the store throw a `RangeError` that nobody saw.
 * @param {string} text
 * @param {number} [max]
 */
export function jsonDepthExceeds(text, max = MAX_IMPORT_DEPTH) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
            if (c === 92) i++;            // backslash: skip the escaped character
            else if (c === 34) inString = false;
        } else if (c === 34) inString = true;
        else if (c === 91 || c === 123) { if (++depth > max) return true; }
        else if (c === 93 || c === 125) depth--;
    }
    return false;
}

/**
 * Parses the text of an import file: the depth is checked on the text first, then `JSON.parse`, then (iteratively, no recursion)
 * the number of nodes and the length of every string. Throws an `Error` with a Dutch message.
 * @param {string} text
 */
export function parseImportText(text) {
    if (jsonDepthExceeds(text)) throw new Error(`Het bestand is te diep genest (maximaal ${MAX_IMPORT_DEPTH} niveaus).`);
    const parsed = JSON.parse(text);
    const stack = [parsed];
    let nodes = 0;
    while (stack.length) {
        const v = stack.pop();
        if (++nodes > MAX_IMPORT_NODES) throw new Error('Het bestand bevat te veel gegevens.');
        if (typeof v === 'string') {
            if (v.length > MAX_IMPORT_STRING) throw new Error(`Het bestand bevat een tekst van meer dan ${MAX_IMPORT_STRING} tekens.`);
        } else if (Array.isArray(v)) {
            for (const x of v) stack.push(x);
        } else if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) {
                if (k.length > MAX_IMPORT_STRING) throw new Error(`Het bestand bevat een naam van meer dan ${MAX_IMPORT_STRING} tekens.`);
                stack.push(v[k]);
            }
        }
    }
    return parsed;
}

/** @param {unknown} v */
function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Record<string, any>[]}
 */
function requireObjectList(v, label, max = Infinity) {
    if (!Array.isArray(v)) throw new Error(`${label} moet een lijst zijn.`);
    if (v.length > max) throw new Error(`${label} bevat te veel items (maximaal ${max}).`);
    if (!v.every(isPlainObject)) throw new Error(`${label} mag alleen objecten bevatten.`);
    const problem = itemIdProblem(v, label);
    if (problem) throw new Error(problem);
    return v;
}

/** A string or a number as given, else the fallback (the original used `x || fallback`). */
function textOr(v, fallback) {
    if (typeof v === 'string') return v || fallback;
    if (typeof v === 'number' && Number.isFinite(v) && v) return v;
    return fallback;
}

/**
 * Turns the parsed content of an import file into the new local configuration (`AdminDashboard.handleFileImport`).
 * Both formats are accepted: the flat export of `exportConfigToJson` and the storage format
 * `{ <folder>: { ...metadata, mappen } }`. The result is a copy with a new id and " (Import)" appended to the name, with
 * the woordenlijst of the file. Input that is not a configuration throws an `Error` with a Dutch message that the caller
 * shows as a toast.
 * @param {unknown} parsed
 * @param {(a: any[], f: (g: any) => any) => any[]} sortFn - `naturalSort`
 * @param {number} [now]
 */
export function configFromImport(parsed, sortFn, now = Date.now()) {
    if (!isPlainObject(parsed)) throw new Error('Verwacht een JSON-object met een configuratie.');
    let imported = /** @type {Record<string, any>} */ (parsed);

    // Handle "Storage" format (if it's wrapped in a top-level folder name)
    if (!imported.templateGuidelines && !imported.mappen) {
        const firstKey = Object.keys(imported)[0];
        if (imported[firstKey] && (imported[firstKey].mappen || imported[firstKey].templateGuidelines)) {
            imported = imported[firstKey];
        }
    }
    if (!isPlainObject(imported)) throw new Error('Verwacht een JSON-object met een configuratie.');

    // Map "Storage" fields to "Internal" fields
    const mappen = isPlainObject(imported.mappen) ? imported.mappen : {};
    const guidelines = requireObjectList(imported.templateGuidelines || mappen.hoofdstukken || [], 'De hoofdstukken (templateGuidelines)', MAX_IMPORT_CHAPTERS);
    const rules = imported.rules
        ? requireObjectList(imported.rules, 'De regels (rules)', MAX_IMPORT_RULES)
        : [
              ...requireObjectList(mappen.terminologie || [], 'De terminologie', MAX_IMPORT_RULES),
              ...requireObjectList(mappen.regels || [], 'De regels', MAX_IMPORT_RULES),
          ];

    // the woordenlijst of the file travels with the import.
    const rawWords = Array.isArray(imported.woordenlijst) ? imported.woordenlijst : Array.isArray(mappen.woordenlijst) ? mappen.woordenlijst : [];
    const woordenlijst = rawWords.filter((w) => typeof w === 'string');

    return {
        id: 'conf-' + now,
        name: String(textOr(imported.name, 'Geïmporteerde Config')) + ' (Import)',
        templateVersion: textOr(imported.templateVersion, '1.0'),
        description: textOr(imported.description, ''),
        toneOfVoice: textOr(imported.toneOfVoice, 'Zakelijk'),
        isActive: imported.isActive !== undefined ? imported.isActive === true : false,
        templateGuidelines: sortFn(guidelines, (g) => g.id),
        rules,
        woordenlijst,
        ...(imported.b1Guidelines !== undefined ? { b1Guidelines: imported.b1Guidelines } : {}),
    };
}

/** File name of the export download (`<name with underscores>_config.json`), unchanged for string names. */
export function exportFileName(name) {
    return `${String(name ?? '').replace(/\s+/g, '_')}_config.json`;
}

/**
 * The trigger words or alternatives of a rule as a list. A configuration stores them as `string[]`, but the
 * configurator's `bind:value` on the rule inputs replaces the array by the typed string on the first edit and saves that
 * string (`AdminDashboard.svelte`). Such a string is read as a comma separated list (the way the other list fields of
 * the configurator are read) and anything else is empty. Entries stay literal text.
 * @param {unknown} v
 * @returns {string[]}
 */
export function ruleWordList(v) {
    if (Array.isArray(v)) return v.filter((w) => typeof w === 'string');
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
    return [];
}
