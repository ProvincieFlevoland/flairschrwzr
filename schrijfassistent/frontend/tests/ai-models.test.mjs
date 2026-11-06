// tests of the model choice per configuratie, kop and opdracht: the pure helpers of src/lib/aiModels.js, what the
// configurator saves and imports, and source level guards on the components that call the AI routes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    MODELS_KEY, CHAPTER_MODEL_TASKS, NOTA_MODEL_TASKS, modelChoice, getChoice, setChoice, cleanModelsBlock, effectiveModel,
    inheritedModel, modelOptions, chaptersWithOwnModels, normaliseModelInfo, SECTION_MODEL_TASKS, hasOwnModels, clearChoices,
} from '../src/lib/aiModels.js';
import { buildUploadPayload, configFromImport } from '../src/lib/adminConfig.js';
import { naturalSort } from '../src/lib/utils/sorting.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const CONFIG = { aiModellen: { standaard: 'slim', opdrachten: { agent_spelling_grammatica: 'snel', titel: 'titel-model' } } };
const KOP = { id: 'h3', aiModellen: { standaard: 'kop-model', opdrachten: { agent_structuur: 'slimst' } } };
const KOP_LEEG = { id: 'h1' };

describe('effectiveModel follows the order of the backend', () => {
    it('picks the most specific choice', () => {
        assert.deepEqual(effectiveModel('agent_structuur', KOP, CONFIG, 'std'), { model: 'slimst', source: 'kop-opdracht' });
        assert.deepEqual(effectiveModel('agent_b1', KOP, CONFIG, 'std'), { model: 'kop-model', source: 'kop' });
        assert.deepEqual(effectiveModel('agent_spelling_grammatica', KOP_LEEG, CONFIG, 'std'), { model: 'snel', source: 'configuratie-opdracht' });
        assert.deepEqual(effectiveModel('agent_b1', KOP_LEEG, CONFIG, 'std'), { model: 'slim', source: 'configuratie' });
        assert.deepEqual(effectiveModel('agent_b1', KOP_LEEG, {}, 'std'), { model: 'std', source: 'standaard' });
        assert.deepEqual(effectiveModel('titel', null, CONFIG, 'std'), { model: 'titel-model', source: 'configuratie-opdracht' });
    });
    it('skips a choice that the AI service does not offer', () => {
        assert.equal(effectiveModel('agent_structuur', KOP, CONFIG, 'std', ['kop-model', 'slim']).model, 'kop-model');
        assert.equal(effectiveModel('agent_structuur', KOP, CONFIG, 'std', []).model, 'std');
    });
});

describe('inheritedModel is what "Overnemen" stands for', () => {
    it('a kop opdracht inherits the kop, then the configuration', () => {
        assert.equal(inheritedModel('kop-opdracht', 'agent_structuur', KOP, CONFIG, 'std'), 'kop-model');
        assert.equal(inheritedModel('kop-opdracht', 'agent_spelling_grammatica', KOP_LEEG, CONFIG, 'std'), 'snel');
        assert.equal(inheritedModel('kop-opdracht', 'agent_b1', KOP_LEEG, CONFIG, 'std'), 'slim');
    });
    it('a configuration opdracht inherits the configuration standaard, not its own choice', () => {
        assert.equal(inheritedModel('configuratie-opdracht', 'agent_spelling_grammatica', null, CONFIG, 'std'), 'slim');
        assert.equal(inheritedModel('configuratie-opdracht', 'agent_b1', null, {}, 'std'), 'std');
        assert.equal(inheritedModel('configuratie', null, null, CONFIG, 'std'), 'std');
    });
});

describe('setChoice and cleanModelsBlock keep the stored block small', () => {
    it('adds and clears choices; an empty block disappears', () => {
        const kop = { id: 'h1' };
        setChoice(kop, 'agent_b1', 'snel');
        assert.deepEqual(kop[MODELS_KEY], { opdrachten: { agent_b1: 'snel' } });
        setChoice(kop, null, ' slim ');
        assert.deepEqual(kop[MODELS_KEY], { standaard: 'slim', opdrachten: { agent_b1: 'snel' } });
        assert.equal(getChoice(kop, null), 'slim');
        assert.equal(getChoice(kop, 'agent_b1'), 'snel');
        assert.equal(getChoice(kop, 'agent_structuur'), '');
        setChoice(kop, 'agent_b1', '');
        setChoice(kop, null, '');
        assert.equal(MODELS_KEY in kop, false);
    });
    it('drops empty and malformed entries', () => {
        assert.equal(cleanModelsBlock(undefined), undefined);
        assert.equal(cleanModelsBlock('slim'), undefined);
        assert.equal(cleanModelsBlock({ standaard: ' ', opdrachten: { a: '' } }), undefined);
        assert.deepEqual(cleanModelsBlock({ standaard: 'x', opdrachten: { a: '', b: 'y', c: 5 } }), { standaard: 'x', opdrachten: { b: 'y' } });
        assert.equal(modelChoice(5), null);
    });
});

describe('modelOptions', () => {
    it('lists the models and marks a stored choice that is no longer offered', () => {
        assert.deepEqual(modelOptions(['a', 'b'], 'a').map((o) => o.value), ['a', 'b']);
        const opts = modelOptions(['a'], 'weg');
        assert.deepEqual(opts[0], { value: 'weg', label: 'weg (niet beschikbaar)', missing: true });
        assert.equal(modelOptions([], 'weg', false)[0].missing, false);
    });
});

describe('chaptersWithOwnModels and normaliseModelInfo', () => {
    it('lists only the koppen with a choice of their own', () => {
        const list = chaptersWithOwnModels([KOP_LEEG, { ...KOP, titel: 'Kern' }]);
        assert.deepEqual(list, [{ id: 'h3', titel: 'Kern', choices: ['alle opdrachten: kop-model', 'Structuur: slimst'] }]);
        assert.deepEqual(chaptersWithOwnModels(undefined), []);
    });
    it('reads the answer of GET /ai-models defensively', () => {
        assert.deepEqual(normaliseModelInfo(null), { selectable: false, defaultModel: '', models: [], error: '', provider: '' });
        assert.deepEqual(
            normaliseModelInfo({ provider: 'litellm', default: 'std', selectable: true, models: ['a', 5, ''], error: 'x' }),
            { selectable: true, defaultModel: 'std', models: ['a'], error: 'x', provider: 'litellm' }
        );
    });
    it('names the opdrachten the Schrijfassistent runs', () => {
        assert.deepEqual(CHAPTER_MODEL_TASKS.map((t) => t.key), ['agent_structuur', 'agent_spelling_grammatica', 'agent_b1', 'agent_woordenlijst']);
        assert.deepEqual(NOTA_MODEL_TASKS.map((t) => t.key), ['titel', 'samenvatting']);
    });
});

describe('onderdelen and the kop switch', () => {
    it('every AI opdracht of a kop belongs to exactly one onderdeel', () => {
        const keys = Object.values(SECTION_MODEL_TASKS).flat().map((t) => t.key).sort();
        assert.deepEqual(keys, CHAPTER_MODEL_TASKS.map((t) => t.key).sort());
        assert.equal('terminologie' in SECTION_MODEL_TASKS || 'regels' in SECTION_MODEL_TASKS, false, 'no AI there');
    });
    it('hasOwnModels and clearChoices drive the switch of a kop', () => {
        assert.equal(hasOwnModels(KOP), true);
        assert.equal(hasOwnModels(KOP_LEEG), false);
        assert.equal(hasOwnModels({ aiModellen: { standaard: '' } }), false);
        const kop = structuredClone(KOP);
        clearChoices(kop);
        assert.equal(hasOwnModels(kop), false);
        assert.equal('aiModellen' in kop, false);
    });
});

describe('save and import carry the model choice', () => {
    it('buildUploadPayload sends the configuration block and leaves it out when empty', () => {
        const working = { name: 'n', templateVersion: '1', templateGuidelines: [KOP], rules: [], aiModellen: { standaard: 'slim', opdrachten: { titel: '' } } };
        const inner = buildUploadPayload(working, 'cfg').cfg;
        assert.deepEqual(inner.aiModellen, { standaard: 'slim' });
        assert.deepEqual(inner.mappen.hoofdstukken[0].aiModellen, KOP.aiModellen);
        assert.equal('aiModellen' in buildUploadPayload({ name: 'n', templateVersion: '1' }, 'cfg').cfg, false);
    });
    it('configFromImport keeps the block of the file', () => {
        const imported = configFromImport({ cfg: { name: 'n', aiModellen: CONFIG.aiModellen, mappen: { hoofdstukken: [KOP] } } }, naturalSort, 1);
        assert.deepEqual(imported.aiModellen, CONFIG.aiModellen);
        assert.deepEqual(imported.templateGuidelines[0].aiModellen, KOP.aiModellen);
        assert.equal('aiModellen' in configFromImport({ cfg: { name: 'n', mappen: { hoofdstukken: [] } } }, naturalSort, 1), false);
    });
});

describe('source guards', () => {
    it('the title and summary calls send the configuration of the nota', () => {
        assert.match(read('src/lib/components/Workspace.svelte'), /generate-nota-title[\s\S]{0,400}config_id: configId/);
        assert.match(read('src/lib/components/NotaDashboard.svelte'), /summarize-nota[\s\S]{0,400}config_id: configId/);
    });
    it('the configurator chooses the model per onderdeel and reads the list through the backend', () => {
        const src = read('src/lib/components/AdminDashboard.svelte');
        for (const section of ['hoofdstukken', 'b1-parameters', 'woordenlijst']) assert.match(src, new RegExp(`sectionRows\\('${section}'`), section);
        assert.match(src, /propertyRows\(workingConfig/);
        assert.match(src, /Eigen AI-model voor deze kop/);
        assert.doesNotMatch(src, /'ai-modellen'/, 'no separate tab any more');
        assert.match(src, /storageFetch\(`\/ai-models`/);
        assert.doesNotMatch(src, /LITELLM_API_KEY|fetch\(\s*['"`]https?:/);
    });
});
