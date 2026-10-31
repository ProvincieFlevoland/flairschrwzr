// @ts-nocheck — JSDoc-only module; TS inference on deep metric objects is overly strict for merges.
/**
 * Canonical B1 deterministic metrics: defaults, merge with org `b1Guidelines` from workspace config,
 * and status helpers. Keep in sync with mkdocs/docs/b1-metrics.md (same numbers and semantics).
 */

/** @typedef {{ label?: string, url?: string, note?: string }} B1Source */
/**
 * @typedef {{
 *   label: string,
 *   hint: string,
 *   target: string,
 *   good: [number, number],
 *   warn: [number, number],
 *   direction: 'lower' | 'higher',
 *   howComputed: string,
 *   sources?: B1Source[],
 * }} B1MetricDefinition
 */

export const B1_METRIC_KEYS = [
    'avgWordsPerSentence',
    'passiveSentencePercent',
    'jargonProxyPer1000',
    'formalWordPer1000',
    'longWordPer1000',
    'avgWordsPerParagraph',
    'cohesionSignalHits'
];

/** Extra deterministic metrics (snapshot + labels); not part of legacy admin metric form. */
export const B1_DD_EXTRA_METRIC_KEYS = [
    'activeVoicePercent',
    'heldereZinnenScore',
    'avgSentencesPerParagraph'
];

/** Direct Duidelijk panel: four chips only (see product spec). */
export const DD_VISIBLE_METRICS = [
    'activeVoicePercent',
    'heldereZinnenScore',
    'avgWordsPerSentence',
    'avgSentencesPerParagraph'
];

/** Weights for the indicative score when only DD chips are shown. */
export const DD_OVERALL_WEIGHTS = {
    activeVoicePercent: 2,
    heldereZinnenScore: 2,
    avgWordsPerSentence: 3,
    avgSentencesPerParagraph: 1
};

/** Weights for the indicative 0–100 score in B1MetricsPanel. */
export const B1_OVERALL_WEIGHTS = {
    avgWordsPerSentence: 3,
    passiveSentencePercent: 2,
    jargonProxyPer1000: 2,
    formalWordPer1000: 1,
    longWordPer1000: 1,
    avgWordsPerParagraph: 1,
    cohesionSignalHits: 2
};

/**
 * Product defaults: bands, labels, how each value is derived (deterministic proxies), and
 * reference-backed `globalSources` / per-metric `sources` (richtlijn vs. indicatieve tooldrempel).
 */
export function getDefaultB1Guidelines() {
    return {
        presetLabel: 'Standaard (product)',
        sourceNote:
            'Deze preset mengt publieke schrijfrichtlijnen (namen en bronnen per metriek) met indicatieve drempels uit deze app. Getallen als “≤ 20% passief” of “≤ 10 jargon / 1000 woorden” zijn geen wettelijke norm — waar dat speelt, staat het bij de bronvermelding. Organisaties kunnen eigen drempels en bronnen instellen via Beheer.',
        globalSources: [
            {
                label: 'CommunicatieRijk — Taalniveau B1',
                url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                note: 'Rijkslijn: korte, eenvoudige en actieve zinnen; eenvoudige woorden.'
            },
            {
                label: 'Schrijven bij de overheid — Korte zinnen',
                url: 'https://www.schrijven-bij-de-overheid.nl/korte-zinnen-voor-een-duidelijke-tekst/',
                note: 'Vuistregel vaak 10–15 woorden per zin; zwaardere zinnen ~20–22 woorden.'
            },
            {
                label: 'KCBR — Thema duidelijke taal',
                url: 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal',
                note: 'Vermijd jargon/ambtenarentaal; o.a. richtlijn maximaal ~15 woorden per zin.'
            },
            {
                label: 'IPLO — Schrijftips taalniveau B1',
                url: 'https://iplo.nl/digitaal-stelsel/toepasbare-regels/maken-testen/schrijfwijzer/schrijftips-taalniveau-b1/',
                note: 'Tips B1, o.a. zinnen niet meer dan ongeveer 15 tot 20 woorden.'
            }
        ],
        metrics: {
            avgWordsPerSentence: {
                label: 'Gem. woorden/zin',
                hint: 'Aansluitend bij gangbare overheidsadviezen: korte zinnen (vuistregel 10–15 woorden; KCBR noemt max. ~15). Waarschuwing 16–20 sluit aan bij de bovenkant van B1-tips (ca. 15–20).',
                target: '≤ 15',
                good: [0, 15],
                warn: [16, 20],
                direction: 'lower',
                howComputed:
                    'Alle woorden in het actieve hoofdstuk gedeeld door het aantal zinnen (gesplitst op . ! ?).',
                sources: [
                    {
                        label: 'Schrijven bij de overheid — Korte zinnen',
                        url: 'https://www.schrijven-bij-de-overheid.nl/korte-zinnen-voor-een-duidelijke-tekst/',
                        note: 'Publieke richtlijn: korte zinnen; vuistregel 10–15 woorden.'
                    },
                    {
                        label: 'KCBR — Duidelijke taal',
                        url: 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal',
                        note: 'Richtlijn: zin van maximaal ongeveer 15 woorden. Productdefault “goed ≤ 15” volgt die strengere lijn.'
                    }
                ]
            },
            passiveSentencePercent: {
                label: 'Passieve zinnen',
                hint: 'Richtlijn: vermijd passief waar mogelijk. Geen vaste “max. X %” in deze bronnen — de drempels hier (≤ 20% goed) zijn een indicatieve regex-proxy in de tool, geen officiële norm.',
                target: '≤ 20%',
                good: [0, 20],
                warn: [21, 35],
                direction: 'lower',
                howComputed:
                    'Percentage zinnen waarin minstens één vast patroon voorkomt (bijv. “wordt/werden”, bepaalde werkwoord + “d”-vorm). Zie technische lijst in documentatie.',
                sources: [
                    {
                        label: 'CommunicatieRijk — Actieve zinnen',
                        url: 'https://www.communicatierijk.nl/vakkennis/taalkompas/stijl/actieve-zinnen',
                        note: 'Richtlijn: vermijd lijdende vorm waar het kan. Geen percentage-drempel in de richtlijn; percentages in deze app zijn een hulpmiddel.'
                    },
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'B1: voorkeur voor actieve zinnen (kwalitatief); geen officiële %-limiet in deze richtlijn.'
                    }
                ]
            },
            jargonProxyPer1000: {
                label: 'Jargon-proxy / 1000 ww.',
                hint: 'Richtlijn: vermijd jargon en ambtenarentaal. De getallen (≤ 10 / 1000) zijn een indicatieve tooldrempel op een vaste woordenlijst — geen tabel uit KCBR of CommunicatieRijk.',
                target: '≤ 10',
                good: [0, 10],
                warn: [11, 25],
                direction: 'lower',
                howComputed:
                    'Aantal treffers op een vaste woordenlijst (proxy), per 1000 woorden in het hoofdstuk.',
                sources: [
                    {
                        label: 'KCBR — Duidelijke taal',
                        url: 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal',
                        note: 'Intentie: duidelijke taal, minder jargon; op de pagina ook verwijzing naar de Handreiking duidelijke taal (PDF). Drempels per 1000 woorden zijn productkeuze op deze proxy-lijst.'
                    },
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'Eenvoudige woorden; geen “jargon per 1000”-norm — getallen in deze tool zijn indicatief.'
                    }
                ]
            },
            formalWordPer1000: {
                label: 'Formele termen / 1000 ww.',
                hint: 'Richtlijn: eenvoudige woorden en toegankelijke toon (o.a. B1). Indicatieve drempel op een vaste formule-lijst in deze app.',
                target: '≤ 20',
                good: [0, 20],
                warn: [21, 40],
                direction: 'lower',
                howComputed:
                    'Aantal treffers op een vaste lijst formele zinsneden, per 1000 woorden in het hoofdstuk.',
                sources: [
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'B1: eenvoudige woorden. Geen officiële “formele termen per 1000”-norm; getallen zijn tool-hulplijnen.'
                    },
                    {
                        label: 'KCBR — Duidelijke taal',
                        url: 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal',
                        note: 'Ondersteunt “lichtere” woordkeuze; drempels hier zijn intern afgeleid.'
                    }
                ]
            },
            longWordPer1000: {
                label: 'Lange woorden / 1000 ww.',
                hint: 'Richtlijn: eenvoudige woorden en begrijpelijke zinnen. In de tool telt “lang” als ≥ 10 letters (proxy); de banden ≤ 60 / 1000 zijn indicatief.',
                target: '≤ 60',
                good: [0, 60],
                warn: [61, 100],
                direction: 'lower',
                howComputed:
                    'Woorden waarvan de letterreeks (zonder leestekens) minimaal 10 letters telt; rate per 1000 woorden.',
                sources: [
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'Wijst op controle op o.a. moeilijke woorden (in productie/tooling); geen publieke “≤ N lange woorden / 1000”-tabel die deze drempel vastlegt.'
                    },
                    {
                        label: 'KCBR — Duidelijke taal',
                        url: 'https://www.kcbr.nl/themas/themas-z/duidelijke-taal',
                        note: 'Duidelijke taal = minder zwaar woordgebruik; 10-lettergrens en percentages zijn technische proxies.'
                    }
                ]
            },
            avgWordsPerParagraph: {
                label: 'Gem. woorden/alinea',
                hint: 'Richtlijn: korte alinea’s voor overzicht. Veel tips noemen ongeveer 100 woorden per alinea als oriëntatie; ≤ 80 hier is een strengere productdefault voor dit paneel.',
                target: '≤ 80',
                good: [0, 80],
                warn: [81, 120],
                direction: 'lower',
                howComputed:
                    'Totaal aantal woorden gedeeld door het geschatte aantal alinea’s (witregels / blokscheiding in de HTML-structuur van het hoofdstuk).',
                sources: [
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'Korte alinea’s en rust (kwalitatief); geen exacte woordlimiet in deze richtlijn.'
                    },
                    {
                        label: 'Voorbeeld — korte alinea’s op B1 (ca. 100 woorden)',
                        url: 'https://www.decommunicatieassistent.nl/schrijf-teksten-op-taalniveau-b1/',
                        note: 'Derde partij; noemt o.a. korte alinea’s en richting ~100 woorden. Niet overheidsbron; dient ter leesorientatie. Product gebruikt 80 als strictere band.'
                    }
                ]
            },
            cohesionSignalHits: {
                label: 'Signaalwoorden',
                hint: 'Richtlijn: heldere structuur en samenhang. Het minimum aantal treffers (≥ 3) is een pure heuristiek in deze tool op een vaste woordenlijst — geen officiële norm.',
                target: '≥ 3',
                good: [3, Infinity],
                warn: [1, 2],
                direction: 'higher',
                howComputed:
                    'Totaal aantal treffers op een vaste lijst signaalwoorden (hele woorden) in het hoofdstuk.',
                sources: [
                    {
                        label: 'CommunicatieRijk — Taalniveau B1',
                        url: 'https://www.communicatierijk.nl/vakkennis/rijkswebsites/aanbevolen-richtlijnen/taalniveau-b1',
                        note: 'Structuur en toegankelijkheid; geen “minimaal X signaalwoorden” in de richtlijn.'
                    },
                    {
                        label: 'Onze Taal — Verbindingswoord / signaalwoord',
                        url: 'https://onzetaal.nl/taalloket/verbindingswoord-signaalwoord/',
                        note: 'Achtergrond over signaalwoorden; het drempelgetal in de app is zelf gekozen.'
                    }
                ]
            },
            activeVoicePercent: {
                label: 'Actief taalgebruik',
                hint: 'Indicatief: 100% minus het geschatte percentage passieve zinnen (zelfde proxies als “Passieve zinnen”). Hoger is actiever geformuleerd.',
                target: '≥ 80%',
                good: [80, Infinity],
                warn: [60, 79],
                direction: 'higher',
                howComputed:
                    '100 − percentage zinnen met een passief patroon (regex-proxy), afgerond op gehele procenten.',
                sources: [
                    {
                        label: 'CommunicatieRijk — Actieve zinnen',
                        url: 'https://www.communicatierijk.nl/vakkennis/taalkompas/stijl/actieve-zinnen',
                        note: 'Kwalitatief; percentages zijn tool-hulplijnen op regex-patronen.'
                    }
                ]
            },
            heldereZinnenScore: {
                label: 'Heldere zinnen',
                hint: 'Combinatie van jargon-, formele woord- en “lange woorden”-proxies (gemiddelde score 0–100; zelfde banden als onderliggende metrics).',
                target: '≥ 75',
                good: [75, Infinity],
                warn: [40, 74],
                direction: 'higher',
                howComputed:
                    'Per proxy (jargon / 1000 ww., formeel / 1000 ww., lang / 1000 ww.) wordt een status bepaald (goed/waarschuwing/slecht), omgerekend naar punten en gemiddeld.',
                sources: [
                    {
                        label: 'Zie ook: Jargon-, formele en lange-woorden metrics',
                        note: 'Deze chip vat drie bestaande proxies samen; ze blijven in de tool berekenbaar maar zijn in DD niet apart zichtbaar.'
                    }
                ]
            },
            avgSentencesPerParagraph: {
                label: 'Gem. zinnen/alinea',
                hint: 'Geschat aantal zinnen per alinea (witregel / blokscheiding). Indicatief: niet te veel zinnen per alinea voor overzicht.',
                target: '≤ 6',
                good: [0, 6],
                warn: [7, 10],
                direction: 'lower',
                howComputed:
                    'Aantal zinnen (split op . ! ?) gedeeld door het geschatte aantal alinea’s (zoals bij “Gem. woorden/alinea”).',
                sources: [
                    {
                        label: 'Schrijven bij de overheid — structuur',
                        url: 'https://www.schrijven-bij-de-overheid.nl/',
                        note: 'Korte alinea’s; exacte zinnen/alinea zijn productproxy.'
                    }
                ]
            }
        }
    };
}

/**
 * @param {unknown} override — partial `b1Guidelines` from workspace config (may be null)
 * @returns {ReturnType<getDefaultB1Guidelines>}
 */
export function mergeB1Guidelines(override) {
    const base = getDefaultB1Guidelines();
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return base;
    }

    /** @type {Record<string, unknown>} */
    const o = /** @type {Record<string, unknown>} */ (override);

    const out = {
        presetLabel:
            typeof o.presetLabel === 'string' && o.presetLabel.trim() !== ''
                ? o.presetLabel
                : base.presetLabel,
        sourceNote:
            typeof o.sourceNote === 'string' && o.sourceNote.trim() !== ''
                ? o.sourceNote
                : base.sourceNote,
        globalSources: 'globalSources' in o ? mergeSources([], o.globalSources) : [...(base.globalSources || [])],
        metrics: { ...base.metrics }
    };

    const om = o.metrics;
    if (om && typeof om === 'object' && !Array.isArray(om)) {
        for (const key of B1_METRIC_KEYS) {
            const partial = /** @type {Record<string, unknown>} */ (om)[key];
            if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
                out.metrics[key] = mergeMetricDef(base.metrics[key], partial);
            }
        }
        for (const key of B1_DD_EXTRA_METRIC_KEYS) {
            const partial = /** @type {Record<string, unknown>} */ (om)[key];
            if (partial && typeof partial === 'object' && !Array.isArray(partial) && base.metrics[key]) {
                out.metrics[key] = mergeMetricDef(base.metrics[key], partial);
            }
        }
    }

    return out;
}

/**
 * @param {B1Source[]} baseSources
 * @param {unknown} override
 * @returns {B1Source[]}
 */
function mergeSources(baseSources, override) {
    if (!Array.isArray(override) || override.length === 0) {
        return Array.isArray(baseSources) ? [...baseSources] : [];
    }
    const next = [];
    for (const item of override) {
        if (!item || typeof item !== 'object') continue;
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        if (!label) continue;
        next.push({
            label,
            url: typeof item.url === 'string' ? item.url.trim() || undefined : undefined,
            note: typeof item.note === 'string' ? item.note.trim() || undefined : undefined
        });
    }
    return next;
}

/**
 * @param {B1MetricDefinition} base
 * @param {Record<string, unknown>} partial
 * @returns {B1MetricDefinition}
 */
function mergeMetricDef(base, partial) {
    const good = cloneNumPair(partial.good, base.good);
    const warn = cloneNumPair(partial.warn, base.warn);
    const direction =
        partial.direction === 'lower' || partial.direction === 'higher'
            ? partial.direction
            : base.direction;

    const sources = 'sources' in partial ? mergeSources([], partial.sources) : base.sources ? [...base.sources] : [];

    return {
        label: typeof partial.label === 'string' && partial.label.trim() !== '' ? partial.label : base.label,
        hint: typeof partial.hint === 'string' && partial.hint.trim() !== '' ? partial.hint : base.hint,
        target: typeof partial.target === 'string' && partial.target.trim() !== '' ? partial.target : base.target,
        good,
        warn,
        direction,
        howComputed:
            typeof partial.howComputed === 'string' && partial.howComputed.trim() !== ''
                ? partial.howComputed
                : base.howComputed,
        sources
    };
}

/**
 * @param {unknown} v
 * @param {[number, number]} fallback
 * @returns {[number, number]}
 */
function cloneNumPair(v, fallback) {
    if (!Array.isArray(v) || v.length < 2) return [fallback[0], fallback[1]];
    const a = Number(v[0]);
    const bRaw = v[1];
    const b =
        bRaw === Infinity || bRaw === 'Infinity' || (typeof bRaw === 'string' && bRaw.toLowerCase() === 'infinity')
            ? Infinity
            : Number(bRaw);
    if (!Number.isFinite(a)) return [fallback[0], fallback[1]];
    if (!Number.isFinite(b) && b !== Infinity) return [fallback[0], fallback[1]];
    return [a, b];
}

/**
 * @param {string} key
 * @param {number} value
 * @param {B1MetricDefinition} def
 * @returns {'good' | 'warn' | 'bad' | null}
 */
export function getB1MetricStatus(key, value, def) {
    if (!def) return null;
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    if (def.direction === 'lower') {
        if (v <= def.good[1]) return 'good';
        if (v <= def.warn[1]) return 'warn';
        return 'bad';
    }
    if (v >= def.good[0]) return 'good';
    if (v >= def.warn[0]) return 'warn';
    return 'bad';
}

/**
 * Human-readable band text for chips (Dutch).
 * @param {B1MetricDefinition} def
 */
export function formatB1MetricBands(def) {
    if (def.direction === 'lower') {
        const g0 = def.good[0];
        const g1 = def.good[1];
        const w0 = def.warn[0];
        const w1 = def.warn[1];
        return `goed: ${g0}–${g1} · waarschuwing: ${w0}–${w1} · buiten band: > ${w1}`;
    }
    const g0 = def.good[0];
    const w1 = def.warn[1];
    if (!Number.isFinite(def.good[1]) && def.good[1] === Infinity) {
        return `goed: ≥ ${g0} · waarschuwing: ${def.warn[0]}–${w1} · buiten band: < ${def.warn[0]}`;
    }
    return `goed: ≥ ${g0} · waarschuwing: ${def.warn[0]}–${w1} · buiten band: < ${def.warn[0]}`;
}

function emptyB1SourceFormRow() {
    return { label: '', url: '', note: '' };
}

/**
 * Maps merged guidelines to Beheer form fields (editable rows for sources, numeric bands).
 * @param {ReturnType<mergeB1Guidelines>} merged
 */
export function formFieldsFromMergedGuidelines(merged) {
    const mapSources = (arr) => {
        if (!Array.isArray(arr) || arr.length === 0) return [emptyB1SourceFormRow()];
        return arr.map((s) => ({
            label: s.label ?? '',
            url: s.url ?? '',
            note: s.note ?? ''
        }));
    };
    /** @type {Record<string, unknown>} */
    const metrics = {};
    for (const key of B1_METRIC_KEYS) {
        const m = merged.metrics[key];
        const g1 = m.good[1];
        metrics[key] = {
            goodLo: m.good[0],
            goodHi: g1 === Infinity ? '' : g1,
            warnLo: m.warn[0],
            warnHi: m.warn[1],
            target: m.target,
            direction: m.direction,
            sources: mapSources(m.sources)
        };
    }
    return {
        presetLabel: merged.presetLabel,
        sourceNote: merged.sourceNote,
        globalSources: mapSources(merged.globalSources),
        metrics
    };
}

/**
 * Builds `b1Guidelines` payload for storage from the Beheer form (`workingConfig.b1Guidelines`).
 * @param {ReturnType<formFieldsFromMergedGuidelines>} form
 * @returns {Record<string, unknown>}
 */
export function b1GuidelinesFromFormFields(form) {
    const filtSrc = (rows) =>
        (rows || [])
            .filter((r) => r && String(r.label ?? '').trim())
            .map((r) => ({
                label: String(r.label).trim(),
                url: String(r.url ?? '').trim() || undefined,
                note: String(r.note ?? '').trim() || undefined
            }));

    const base = getDefaultB1Guidelines();
    /** @type {Record<string, unknown>} */
    const metrics = {};

    for (const key of B1_METRIC_KEYS) {
        const f = form.metrics[key];
        const b = base.metrics[key];
        if (!f) throw new Error(`Ontbrekende metric: ${key}`);

        const dir = f.direction === 'higher' ? 'higher' : 'lower';
        const g0 = Number(f.goodLo);
        const w0 = Number(f.warnLo);
        const w1 = Number(f.warnHi);

        if (!Number.isFinite(g0)) {
            throw new Error(`${key}: “Goed (van)” moet een getal zijn.`);
        }
        if (!Number.isFinite(w0) || !Number.isFinite(w1)) {
            throw new Error(`${key}: waarschuwingsgrenzen moeten getallen zijn.`);
        }

        /** @type {number|string} */
        let g1;
        if (dir === 'higher') {
            const raw = f.goodHi;
            if (raw === '' || raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
                g1 = 'Infinity';
            } else {
                g1 = Number(raw);
                if (!Number.isFinite(g1)) {
                    throw new Error(`${key}: “Goed (tot)” moet een getal zijn of leeg voor geen bovengrens.`);
                }
            }
        } else {
            const raw = f.goodHi;
            if (raw === '' || raw === null || raw === undefined) {
                g1 = b.good[1];
            } else {
                g1 = Number(raw);
                if (!Number.isFinite(g1)) {
                    throw new Error(`${key}: “Goed (tot)” moet een getal zijn.`);
                }
            }
        }

        metrics[key] = {
            good: [g0, g1],
            warn: [w0, w1],
            target: String(f.target ?? '').trim() || b.target,
            direction: dir,
            sources: filtSrc(f.sources)
        };
    }

    const preset = String(form.presetLabel ?? '').trim();
    const note = String(form.sourceNote ?? '').trim();
    /** @type {Record<string, unknown>} */
    const out = {
        globalSources: filtSrc(form.globalSources),
        metrics
    };
    if (preset) out.presetLabel = preset;
    if (note) out.sourceNote = note;
    return out;
}

/**
 * Ready-made `b1Guidelines` payload for Beheer (all seven metric keys, sample sources + one threshold override).
 * `cohesionSignalHits.good[1]` may be the string `"Infinity"` (parsed as upper bound for “hoger is beter”).
 * @returns {Record<string, unknown>}
 */
export function getB1GuidelinesAdminExample() {
    const sampleSource = (label, note) => ({
        label,
        url: 'https://voorbeeld.invalid/richtlijn',
        note
    });
    return {
        presetLabel: 'Voorbeeld: organisatienorm',
        sourceNote:
            'Vervang deze teksten door jullie eigen normering. Alleen de sleutels onder metrics hieronder worden gebruikt.',
        globalSources: [
            {
                label: 'Algemene schrijfregels (intranet)',
                url: '',
                note: 'Link invullen of veld url weglaten'
            }
        ],
        metrics: {
            avgWordsPerSentence: {
                good: [0, 18],
                warn: [19, 24],
                target: '≤ 18',
                direction: 'lower',
                sources: [sampleSource('Zinslengte', 'Conventie organisatie')]
            },
            passiveSentencePercent: {
                sources: [sampleSource('Passieve zinnen', 'Taalleerstof')]
            },
            jargonProxyPer1000: {
                sources: [sampleSource('Jargon-proxy', 'Woordenlijst intern')]
            },
            formalWordPer1000: {
                sources: [sampleSource('Formele termen', 'Stijlgids')]
            },
            longWordPer1000: {
                sources: [sampleSource('Lange woorden', 'Leesbaarheid')]
            },
            avgWordsPerParagraph: {
                sources: [sampleSource('Alinealengte', 'Alinea-advies')]
            },
            cohesionSignalHits: {
                good: [3, 'Infinity'],
                warn: [1, 2],
                direction: 'higher',
                sources: [sampleSource('Signaalwoorden', 'Samenhang')]
            }
        }
    };
}
