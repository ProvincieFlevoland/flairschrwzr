/**
 * Builds large B1 lexicon JSON files from the OpenTaal Dutch word list (BSD / CC BY).
 *
 * Prerequisite: download once (or use cached):
 *   curl -o scripts/tmp/opentaal-wordlist.txt \
 *     https://raw.githubusercontent.com/OpenTaal/opentaal-wordlist/master/wordlist.txt
 *
 * Run: node scripts/build-b1-lexicons.mjs
 *
 * Outputs to src/lib/data/b1-lexicon-*.json (sorted, deduped).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_WORDLIST = path.join(__dirname, 'tmp', 'opentaal-wordlist.txt');
const OUT_DIR = path.join(__dirname, '../src/lib/data');
const TARGET_MIN = 1000;
/** Hard cap keeps bundles and regex phrase passes bounded; lists stay ≥ TARGET_MIN unless heuristics fail. */
const TARGET_MAX = 5000;

/** Very common tokens excluded from *cohesion* (would dominate counts). */
const COH_EXCLUDE = new Set(
    `de het een en van te is was waren werd worden worden tenzij
ik jij je u we wij zij ze mij jou hem haar hun ons jullie
dit dat deze die zo al nu nog ook niet geen wel maar of
in op aan uit bij naar over om door tot vos des
ben kan kon moet zal zou willen mag mocht moeten
tegen tussen zonder binnen buiten onder boven
iedereen iemand niemand ergens nergens
mg ml ok tv pc`
        .split(/\s+/g)
        .filter(Boolean)
);

/** Casual / core vocab excluded from *formal* proxy (too colloquial despite long form). */
const FORMAL_EXCLUDE = new Set(
    `gefeliciteerd gefeliciteerdje supergaaf leukst leukste vriendinnen
vriendinnetje voetbalwedstrijd verjaardagsfeest smartphone whatsapp`
        .split(/\s+/g)
        .filter(Boolean)
);

/** Longer stems / compounds only (avoids “recht” in “Utrecht”). */
const JARGON_MARKERS = [
    'wetgev',
    'wettig',
    'wetteli',
    'rechtsp',
    'rechtmat',
    'rechtst',
    'besluitv',
    'besluitr',
    'beleids',
    'beleidsr',
    'verorden',
    'subsidi',
    'subsidie',
    'bestuurs',
    'minister',
    'gemeenteb',
    'gemeenter',
    'provincie',
    'staatsrad',
    'staatssec',
    'collegev',
    'concorg',
    'aanwijzi',
    'beschikki',
    'beschikb',
    'uitvoeri',
    'uitvoerba',
    'uitvoerder',
    'handhavi',
    'handhaving',
    'sanctie',
    'vergunn',
    'vergunning',
    'ontheffi',
    'kwalific',
    'bevoegdh',
    'bevoegdhe',
    'mandaat',
    'delegatie',
    'delegat',
    'europese',
    'commissi',
    'richtlijn',
    'implement',
    'grondslag',
    'motivati',
    'paragraaf',
    'artikels',
    'artikelg',
    'verdrage',
    'verdrag',
    'juridisc',
    'amvb',
    'procedure',
    'procure',
    'inspecti',
    'toezichth',
    'toezichts',
    'overheids',
    'overheid',
    'publiekr',
    'publieks',
    'administ',
    'beleidsno',
    'normstel',
    'toetsing',
    'toetskader',
    'openbaarh',
    'garantst',
    'afwegink',
    'belangenaf',
    'archiefb',
    'woobesl',
    'privacy',
    'gegevensb',
    'avg-p',
    'aanbested',
    'opdrachtg',
    'opdrachtn',
    'contractb',
    'aansprakel',
    'geschilk',
    'procesve',
    'rechtbank',
    'gerechtsh',
    'raadvanst',
    'bewindsp',
    'kamerlid',
    'fractiev',
    'besluitfo',
    'besluits',
    'vaststel',
    'goedkeur',
    'afkeurin',
    'randvoor',
    'doelstel',
    'prestatie',
    'taakstell',
    'begrotings',
    'fiscaal',
    'milieuver',
    'beveili',
    'digitalis',
    'informatie',
    'transpar',
    'verantwoo',
    'integrite',
    'monitorin',
    'evaluati',
    'inkaderi',
    'voorhang',
    'beschikbaarst',
    'dwangmid',
    'lastgege',
    'dwangbes'
];

function wordHasJargonMarker(w) {
    const x = w.toLowerCase();
    for (const m of JARGON_MARKERS) {
        if (x.includes(m)) return true;
    }
    return false;
}

/** Latin / legal clerical tokens often used in policy text (single-token spellings in OpenTaal). */
const JARGON_LATINISH =
    /^(per|pro|contra|extra|infra|ultra|supra|versus|ceteris|paribus|vis)$/i;

const FORMAL_SUBSTR = new RegExp(
    [
        'voornoemd',
        'voormeld',
        'onderhavig',
        'desbetreff',
        'ingevolge',
        'krachtens',
        'conform',
        'inzake',
        'dienaangaand',
        'mitsdien',
        'derhalve',
        'althans',
        'niettemin',
        'desondanks',
        'behoudens',
        'bijgevolgens?',
        'wegens',
        'gezien',
        'terzake',
        'tenzijder',
        'bij wijze van',
        'bij monde',
        'ten aanzien',
        'ten behoeve',
        'ten gunste',
        'ten laste',
        'ten tijde',
        'ten gevolge',
        'in aanmerking',
        'in het licht',
        'met betrekking',
        'met het oog',
        'zijnde',
        'casu quo',
        'quasi',
        'alsmede',
        'zulks'
    ].join('|'),
    'i'
);

const FORMAL_SUFFIX = /(achtig|matig|elijk|elijke|selijk|eerder|eits|matie|ering|stuk|wege)$/i;

const COH_PREFIX = new RegExp(
    [
        '^(daar|hier|waar|waarom|waardoor|daardoor|daarmee|daaruit|daarop|daarin|daarbij|daarna|daarnaast|daartoe|daarvoor|daarover|daaronder|hierbij|hiermee|hierin|hierop|hieruit|hiervoor|hierover|hiertegen|waarbij|waarmee|waarin|waarop|waaruit|waarvoor|waarover|waaronder|waarna|waarnaar)',
        '^(omdat|doordat|nadat|voordat|indien|mits|tenzij|ofschoon|hoewel|terwijl|aangezien|zodat|zolang|zodra|wanneer|alhoewel|indien|ingeval)',
        '^(bovendien|intussen|ondertussen|evenwel|eveneens|namelijk|immers|echter|integendeel|desondanks|daarentegen|zodoende|derhalve|samenvattend|concluderend|kortom|allereerst|ten slotte|ten eerste|ten tweede|ten derde|met name|met andere woorden)',
        '^(doch|nochtans|desalniettemin|weliswaar|enerzijds|anderzijds|tot slot|met betrekking tot|in tegenstelling tot|op grond van|in het kader van|aan de hand van|met het oog op|voor zover|voor zoverre)',
        '^(concluderend|overigens|trouwens|overigens|bijkomend|aanvullend|daarbij komt|verder|voorts|totdat|sindsdien|aldus|zulks)'
    ].join('|'),
    'i'
);

function normalizeLine(line) {
    return String(line)
        .trim()
        .toLowerCase()
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ');
}

function isPlausibleWordToken(w) {
    if (!w || w.length < 2) return false;
    if (/^\d[\d.-]*$/.test(w)) return false;
    if (!/[a-zà-ÿ]/i.test(w)) return false;
    if (w.length > 80) return false;
    return true;
}

function pickJargon(words, seeds) {
    const out = new Set(seeds.map((s) => s.toLowerCase()));
    for (const w of words) {
        if (!isPlausibleWordToken(w)) continue;
        if (w.includes(' ')) {
            if (wordHasJargonMarker(w) || FORMAL_SUBSTR.test(w)) out.add(w);
            continue;
        }
        if (w.length < 6) continue;
        if (JARGON_LATINISH.test(w)) {
            out.add(w);
            continue;
        }
        if (!wordHasJargonMarker(w)) continue;
        if (w.length < 8 && !/(wet|amvb)/i.test(w)) continue;
        out.add(w);
    }
    return out;
}

function pickFormal(words, seeds) {
    const out = new Set(seeds.map((s) => s.toLowerCase()));
    for (const w of words) {
        if (!isPlausibleWordToken(w)) continue;
        if (FORMAL_EXCLUDE.has(w)) continue;
        if (w.includes(' ')) {
            if (FORMAL_SUBSTR.test(w)) out.add(w);
            continue;
        }
        if (w.length < 8) continue;
        if (FORMAL_SUBSTR.test(w) || FORMAL_SUFFIX.test(w) || (w.length >= 13 && /(heid|heidss?|elijk)$/i.test(w))) {
            out.add(w);
        }
    }
    return out;
}

function pickCohesion(words, seeds) {
    const out = new Set(seeds.map((s) => s.toLowerCase()));
    for (const w of words) {
        if (!isPlausibleWordToken(w)) continue;
        const noSpace = !w.includes(' ');
        if (noSpace) {
            if (w.length < 3 || w.length > 22) continue;
            if (COH_EXCLUDE.has(w)) continue;
            if (!COH_PREFIX.test(w)) continue;
            out.add(w);
        } else {
            if (w.length < 8 || w.length > 55) continue;
            if (!COH_PREFIX.test(w)) continue;
            if (/\b(de|het|een)\b/i.test(w) && w.split(/\s+/).length < 4) continue;
            out.add(w);
        }
    }
    return out;
}

function relaxJargon(words, set) {
    if (set.size >= TARGET_MIN) return;
    /** Secondary tier: policy / legal affixes inside longer compounds (exclude placename false friends). */
    const loose = /(recht|wet)(geving|gevig|telijk|vaard|schap|lijk|zijdig|perceel|terug|spraak)|wets(s|ten|artikel|voorstel)?$/i;
    const exclude = /^(utrecht|amsterdam|rotterdam|nieuwegein)$/i;
    for (const w of words) {
        if (set.size >= TARGET_MIN) return;
        if (!isPlausibleWordToken(w) || w.includes(' ')) continue;
        if (w.length < 9) continue;
        if (exclude.test(w)) continue;
        if (loose.test(w)) set.add(w);
    }
}

function relaxFormal(words, set) {
    for (const w of words) {
        if (set.size >= TARGET_MIN) return;
        if (!isPlausibleWordToken(w)) continue;
        if (w.includes(' ')) {
            if (w.length >= 14) set.add(w);
            continue;
        }
        if (w.length >= 11 && /(end|ende|enden|eren|ering|eringen)$/i.test(w)) set.add(w);
    }
}

function relaxCohesion(words, set) {
    const extra = new RegExp(
        '^(want|doch|echt|toch|dan|toen|als|zo|zoals|zod|zowaar|namelijk|eigenlijk|inderdaad|blijkbaar|schijnbaar|hopelijk|helaas|gelukkig|jammer|vermoedelijk|lijkt|lijken|echter|overigens|bovendien|bijgevolg|desondanks|daarentegen|binnen|buiten|ondanks|ondertussen|intussen|vervolgens|voorheen|naderhand|subtiel|duidelijk|plots|plotseling|plotselinge|uiteindelijk|aanvankelijk|oorspronkelijk|gewoonlijk|normaliter|kortom|samengevat|gevolg|reden|gevolgtrekking|bewering|stelling|argument|contrast|vergelijk|vergelijking|parallel|tegenstelling|nuancering|nuance|voorbeeld|illustratie|samenvatting|slotconclusie)',
        'i'
    );
    const adverbishSuffix = /(elijk|telijk|wijs|matig|ermaar|ermee|erin|erop|eruit|ervoor|erdoor|erover)$/i;
    for (const w of words) {
        if (set.size >= TARGET_MAX) return;
        if (!isPlausibleWordToken(w) || w.includes(' ')) continue;
        if (w.length < 4 || w.length > 22) continue;
        if (COH_EXCLUDE.has(w)) continue;
        if (extra.test(w) || (w.length <= 16 && adverbishSuffix.test(w))) set.add(w);
    }
}

function main() {
    if (!fs.existsSync(REPO_WORDLIST)) {
        console.error(`Missing OpenTaal wordlist at ${REPO_WORDLIST}`);
        console.error('Download with: curl -fsSL -o scripts/tmp/opentaal-wordlist.txt https://raw.githubusercontent.com/OpenTaal/opentaal-wordlist/master/wordlist.txt');
        process.exit(1);
    }
    const raw = fs.readFileSync(REPO_WORDLIST, 'utf8');
    const words = raw.split(/\r?\n/).map(normalizeLine).filter(Boolean);

    const seedJargon = [
        'ingevolge',
        'onverminderd',
        'voorzover',
        'derhalve',
        'althans',
        'niettemin',
        'subsidiair',
        'conform',
        'inzake',
        'dienovereenkomstig',
        'juridisch',
        'rechtspersoon',
        'bestuursorgaan',
        'rechtmatig',
        'wettelijk'
    ];
    const seedFormal = [
        'teneinde',
        'alsmede',
        'derhalve',
        'namens',
        'dienaangaande',
        'betreffende',
        'zulks',
        'ingevolge',
        'casu quo',
        'mitsdien',
        'onderhavige',
        'desbetreffende',
        'voornoemd',
        'voormeld',
        'hieromtrent',
        'aldus',
        'dientengevolge',
        'ten einde',
        'gaarne',
        'uwer',
        'onzerzijds',
        'zijnerzijds'
    ];
    const seedCohesion = [
        'daarom',
        'bovendien',
        'echter',
        'daarentegen',
        'ten slotte',
        'samenvattend',
        'enerzijds',
        'anderzijds',
        'hoewel',
        'omdat',
        'desondanks',
        'intussen',
        'evenwel',
        'immers',
        'namelijk',
        'derhalve',
        'overigens',
        'trouwens',
        'aldus',
        'daarbij',
        'hiermee',
        'waardoor',
        'met andere woorden',
        'aan de andere kant',
        'in het bijzonder'
    ];

    let jargon = pickJargon(words, seedJargon);
    let formal = pickFormal(words, seedFormal);
    let cohesion = pickCohesion(words, seedCohesion);

    if (jargon.size < TARGET_MIN) relaxJargon(words, jargon);
    if (formal.size < TARGET_MIN) relaxFormal(words, formal);
    /** Grow discourse lexicon toward TARGET_MAX (OpenTaal + suffix tier); pickCohesion alone stays ~1k. */
    relaxCohesion(words, cohesion);

    /**
     * Alphabetical output; if over TARGET_MAX, keep longest tokens first among non-pinned entries.
     * Pinned terms (seeds + product defaults) are never dropped so tests and UI examples stay stable.
     */
    function finalize(s, pinned) {
        const pin = new Set(pinned.map((x) => x.toLowerCase()));
        let arr = [...s];
        if (arr.length <= TARGET_MAX) return arr.sort((a, b) => a.localeCompare(b, 'nl'));
        const locked = arr.filter((x) => pin.has(x.toLowerCase()));
        const pool = arr.filter((x) => !pin.has(x.toLowerCase()));
        pool.sort((a, b) => b.length - a.length || a.localeCompare(b, 'nl'));
        const take = Math.max(0, TARGET_MAX - locked.length);
        return [...locked, ...pool.slice(0, take)].sort((a, b) => a.localeCompare(b, 'nl'));
    }

    const pinAll = [...new Set([...seedJargon, ...seedFormal, ...seedCohesion])];

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const jargonArr = finalize(jargon, pinAll);
    const formalArr = finalize(formal, pinAll);
    const cohesionArr = finalize(cohesion, pinAll);

    fs.writeFileSync(path.join(OUT_DIR, 'b1-lexicon-jargon.json'), JSON.stringify(jargonArr, null, 0) + '\n');
    fs.writeFileSync(path.join(OUT_DIR, 'b1-lexicon-formal.json'), JSON.stringify(formalArr, null, 0) + '\n');
    fs.writeFileSync(path.join(OUT_DIR, 'b1-lexicon-cohesion.json'), JSON.stringify(cohesionArr, null, 0) + '\n');

    const attr = `B1 lexicon JSON files in this directory are derived heuristically from the Dutch word list
by OpenTaal (Revised BSD License and/or CC BY 3.0).
Source: https://github.com/OpenTaal/opentaal-wordlist
Regenerate: node scripts/build-b1-lexicons.mjs (after downloading scripts/tmp/opentaal-wordlist.txt).
`;
    fs.writeFileSync(path.join(OUT_DIR, 'b1-lexicon-ATTRIBUTION.txt'), attr);

    console.log('Counts:', {
        jargon: jargonArr.length,
        formal: formalArr.length,
        cohesion: cohesionArr.length
    });

    for (const [name, n] of [
        ['jargon', jargonArr.length],
        ['formal', formalArr.length],
        ['cohesion', cohesionArr.length]
    ]) {
        if (n < TARGET_MIN) {
            console.error(`ERROR: ${name} has only ${n} entries (need >= ${TARGET_MIN}). Tune heuristics in build-b1-lexicons.mjs`);
            process.exit(1);
        }
    }
}

main();
