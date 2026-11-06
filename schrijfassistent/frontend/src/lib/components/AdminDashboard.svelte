<script>
    /**
     * Admin dashboard: backend config sync, import/export and configuration management (the configurator).
     *
     * - only a beheerder (Open WebUI role `admin`, identityAdapter.js) gets the configurator; every other role sees a notice and
     *   no request is made. The backend refuses configuration writes from any other role as well;
     * - `alert()` became toasts, `confirm()` the typed-confirmation modal, the download anchor is appended to the container
     *   instead of `document.body`; the way back to the overview is the header's "Ga naar nota overzicht" (Header.svelte);
     * - reads are aborted when the view is left (the polling timer stops with it), a save is never aborted half way;
     * - the id of a configuration is checked before a save, an import file is checked before it is accepted.
     */
    import { onMount, onDestroy, getContext } from 'svelte';
    import { dbStore, saveDB } from '$lib/store.js';
    import { addNotification } from '$lib/notificationStore.js';
    import { get } from 'svelte/store';
    import { naturalSort } from '$lib/utils/sorting.js';
    import DeleteConfigModal from '$lib/components/DeleteConfigModal.svelte';
    import {
        B1_METRIC_KEYS,
        getDefaultB1Guidelines,
        getB1GuidelinesAdminExample,
        mergeB1Guidelines,
        formFieldsFromMergedGuidelines,
        b1GuidelinesFromFormFields
    } from '$lib/utils/b1Guidelines.js';

    const _b1Defaults = getDefaultB1Guidelines();
    /** Per-metric metadata for Beheer cards (single load). */
    const B1_ADMIN_METRIC_ROWS = B1_METRIC_KEYS.map((key) => {
        const d = _b1Defaults.metrics[key];
        return { key, label: d.label, howComputed: d.howComputed };
    });

    /** Tab slug → shown label (Hoofdstukken … B1-parameters). */
    function configTabLabel(tab) {
        if (tab === 'b1-parameters') return 'B1-parameters';
        if (tab === 'eigenschappen') return 'Eigenschappen';
        if (!tab) return '';
        return tab.charAt(0).toUpperCase() + tab.slice(1);
    }

    /** The mapped Open WebUI user (`beheerder` | `auteur`); the configurator is for a beheerder only. */
    export let currentUser = null;

    $: isBeheerder = !!currentUser && currentUser.role === 'beheerder';

    /** The container element (`.sa-root`); the export download anchor is appended here instead of `document.body`. */
    const rootEl = getContext(ROOT_EL_CONTEXT);

    /** Aborts the reads of this view when it is left (unmount and view switches leave nothing in flight). */
    const viewAbort = new AbortController();
    let destroyed = false;
    let sessionNoticeShown = false;
    const readInit = () => ({ signal: viewAbort.signal });
    /** @param {unknown} e */
    const isAbort = (e) => destroyed || (e && typeof e === 'object' && /** @type {any} */ (e).name === 'AbortError');

    let activeTab = 'configurator'; // Default to configurator
    let selectedConfigId = null;
    let configTab = ''; // Changed from hardcoded 'templates'
    let backendSubfolders = [];

    let fileInputRef;
    let refreshInterval;

    let backendConfigIds = [];
    let configurations = [];
    let isLoadingConfigs = true;
    let configListSyncing = false;
    import { storageFetch } from '$lib/apiClient.js';
    import { ROOT_EL_CONTEXT } from '$lib/hostBridge.js';
    import {
        MODELS_KEY,
        CHAPTER_MODEL_TASKS,
        NOTA_MODEL_TASKS,
        SECTION_MODEL_TASKS,
        setChoice,
        clearChoices,
        hasOwnModels,
        inheritedModel,
        chaptersWithOwnModels,
        normaliseModelInfo
    } from '$lib/aiModels.js';
    import AiModelCard from '$lib/components/AiModelCard.svelte';
    import { MAX_IMPORT_BYTES, validateConfigId, workingConfigItemProblem, buildUploadPayload, configFromImport, parseImportText, exportFileName } from '$lib/adminConfig.js';
    import './AdminDashboard.css';

    let showDeleteConfirm = false;
    let configIdToDelete = null;
    let configNameToDelete = "";
    /** Typed confirmation for removing a chapter template (was `confirm('Sectie verwijderen?')`). */
    let sectionIdToDelete = null;

    /**
     * Loads configuration ids from the storage API and auto-selects the first when none selected.
     * @param {boolean} [showSpinner] — pass true for refresh/sync button (shows spinner)
     */
    async function fetchBackendConfigs(showSpinner = false) {
        if (destroyed) return;
        if (showSpinner) configListSyncing = true;
        try {
            const response = await storageFetch(`/configurations`, readInit());
            if (destroyed) return;
            // `GET /configurations` lists the whole container and this runs every 10 seconds (onMount).
            // Known behaviour: an error answer ({detail}) is read like a list, so a failing call empties
            // `backendConfigIds` and every synced configuration shows under "lokale configuraties" until the next poll.
            if (response.status === 401 || response.status === 403) noteSessionProblem();
            const data = await response.json();
            backendConfigIds = data.configurations || [];

            // Auto-select first if none selected
            if (!selectedConfigId && backendConfigIds.length > 0) {
                selectedConfigId = backendConfigIds[0];
            }
            if (showSpinner) {
                addNotification('Configuraties succesvol gesynchroniseerd met de database', 'success');
            }

            await Promise.all(backendConfigIds.map((id) => fetchConfigMetadata(id)));
        } catch (error) {
            if (isAbort(error)) return;
            console.error('Failed to fetch configurations from backend:', error);
            backendConfigIds = [];
        } finally {
            isLoadingConfigs = false;
            if (showSpinner) configListSyncing = false;
        }
    }

    /** 401: the Open WebUI session ended; 403: not a beheerder or a firewall refused the request (the 135 kB save can meet the WAF body limit). */
    const SESSION_OR_ROLE_MESSAGE = (what) => `${what}: de sessie is mogelijk verlopen of de aanvraag is geweigerd (alleen beheerders mogen configuraties wijzigen). Open de Schrijfassistent opnieuw of neem contact op met de beheerder.`;

    /** 401 and 403 tell the beheerder that the Open WebUI session may have ended ( g, once per view). */
    function noteSessionProblem() {
        if (sessionNoticeShown) return;
        sessionNoticeShown = true;
        addNotification('De configuraties zijn niet op te halen: de sessie is mogelijk verlopen. Open de Schrijfassistent opnieuw.', 'error', 8000);
    }


    /** Loads metadata.json from storage and merges fields (incl. isActive) into dbStore. */
    async function fetchConfigMetadata(configId) {
        if (!configId || !backendConfigIds.includes(configId)) return;
        try {
            const response = await storageFetch(`/configurations/${encodeURIComponent(configId)}/metadata`, readInit());
            if (!response.ok) return;
            const meta = await response.json();
            if (destroyed) return;
            dbStore.update(curr => {
                if (!curr.configurations) curr.configurations = [];
                let idx = curr.configurations.findIndex(c => c.id === configId);
                if (idx === -1) {
                    curr.configurations.push({
                        id: configId,
                        name: meta.name || configId,
                        templateVersion: meta.templateVersion || '1.0',
                        description: meta.description || '',
                        toneOfVoice: meta.toneOfVoice || 'Zakelijk',
                        rules: [],
                        templateGuidelines: [],
                        isActive: meta.isActive !== undefined ? meta.isActive : true,
                        ...(meta.b1Guidelines !== undefined ? { b1Guidelines: meta.b1Guidelines } : {}),
                        ...(meta[MODELS_KEY] !== undefined ? { [MODELS_KEY]: meta[MODELS_KEY] } : {})
                    });
                } else {
                    const config = curr.configurations[idx];
                    if (meta.name) config.name = meta.name;
                    if (meta.templateVersion) config.templateVersion = meta.templateVersion;
                    if (meta.description !== undefined) config.description = meta.description;
                    if (meta.toneOfVoice) config.toneOfVoice = meta.toneOfVoice;
                    if (meta.b1Guidelines !== undefined) config.b1Guidelines = meta.b1Guidelines;
                    if (meta[MODELS_KEY] !== undefined) config[MODELS_KEY] = meta[MODELS_KEY];
                    config.isActive = meta.isActive !== undefined ? meta.isActive : true;
                }
                return { ...curr };
            });
            saveDB();
        } catch (error) {
            if (isAbort(error)) return;
            console.error(`Failed to fetch metadata for ${configId}:`, error);
        }
    }

    /** Resolves subfolders for a config; local-only ids get fixed defaults (hoofdstukken/terminologie/regels). */
    async function fetchConfigSubfolders(configId) {
        if (!configId) return;

        // If it's a new local config, provide defaults
        if (!backendConfigIds.includes(configId)) {
            backendSubfolders = ['hoofdstukken', 'terminologie', 'regels', 'b1-parameters', 'eigenschappen', 'woordenlijst'];
            if (!backendSubfolders.includes(configTab)) {
                configTab = 'hoofdstukken';
            }
            return;
        }

        try {
            const response = await storageFetch(`/configurations/${encodeURIComponent(configId)}/subfolders`, readInit());
            const data = await response.json();
            if (destroyed) return;
            const found = data.subfolders || [];
            // Merge found subfolders with defaults to ensure buttons are always present
            const defaults = ['hoofdstukken', 'terminologie', 'regels', 'b1-parameters', 'eigenschappen', 'woordenlijst'];
            backendSubfolders = [...new Set([...defaults, ...found])];

            if (!configTab || !backendSubfolders.includes(configTab)) {
                configTab = 'hoofdstukken';
            }
        } catch (error) {
            if (isAbort(error)) return;
            console.error(`Failed to fetch subfolders for ${configId}:`, error);
            backendSubfolders = [];
        }
    }

    /** Loads JSON for one subfolder and writes chapters/rules into the correct fields in `dbStore`. */
    async function fetchSubfolderData(configId, subfolder) {
        if (!configId || !subfolder) return;
        try {
            const response = await storageFetch(`/configurations/${encodeURIComponent(configId)}/${encodeURIComponent(subfolder)}/data`, readInit());
            const data = await response.json();
            if (destroyed) return;
            const folderData = data.data || [];

            // Update the local dbStore with this real data from storage
            dbStore.update(curr => {
                if (!curr.configurations) curr.configurations = [];
                let idx = curr.configurations.findIndex(c => c.id === configId);

                // If it's not in our store yet, we need to add a placeholder first
                if (idx === -1) {
                    const newConfigObj = {
                        id: configId,
                        name: configId,
                        templateVersion: '1.0',
                        description: 'Loaded from storage.',
                        rules: [],
                        templateGuidelines: []
                    };
                    curr.configurations.push(newConfigObj);
                    idx = curr.configurations.length - 1;
                }

                const config = curr.configurations[idx];
                if (subfolder === 'hoofdstukken' || subfolder === 'templates') {
                    config.templateGuidelines = naturalSort(folderData, g => g.id);
                } else if (subfolder === 'terminologie' || subfolder === 'terms') {
                    const nonTermRules = (config.rules || []).filter(r => r.category !== 'Terminologie');
                    config.rules = [...nonTermRules, ...folderData];
                } else if (subfolder === 'regels' || subfolder === 'rules') {
                    const termRules = (config.rules || []).filter(r => r.category === 'Terminologie');
                    config.rules = [...termRules, ...folderData];
                } else if (subfolder === 'woordenlijst') {
                    config.woordenlijst = Array.isArray(folderData) ? folderData : [];
                }

                return { ...curr };
            });
            return true;
        } catch (error) {
            if (isAbort(error)) return false;
            console.error(`Failed to fetch data for ${configId}/${subfolder}:`, error);
            return false;
        }
    }

    /** Id of the synced configuration whose stored woordenlijst has been merged into the working copy. */
    let wordlistLoadedFor = null;

    /**
     * ( fixed): the working copy is a clone taken once per selected id, so the woordenlijst that `fetchSubfolderData`
     * writes into the store afterwards never reached it and every save sent `woordenlijst: []`. The stored list is now read on
     * selection and merged into the working copy (union, so words typed in the meantime stay). Returns true when the stored list is in.
     */
    async function loadStoredWoordenlijst(configId) {
        if (!configId || !backendConfigIds.includes(configId)) return true;
        if (wordlistLoadedFor === configId) return true;
        const ok = await fetchSubfolderData(configId, 'woordenlijst');
        if (!ok || destroyed) return false;
        const stored = (get(dbStore).configurations || []).find(c => c.id === configId)?.woordenlijst;
        if (workingConfig && initialConfigId === configId && Array.isArray(stored)) {
            workingConfig.woordenlijst = [...new Set([...stored, ...(workingConfig.woordenlijst || [])])];
        }
        wordlistLoadedFor = configId;
        return true;
    }

    onDestroy(() => {
        destroyed = true;
        if (refreshInterval) clearInterval(refreshInterval);
        try { viewAbort.abort(); } catch { /* nothing in flight */ }
    });

    onMount(() => {
        // The configurator is for a beheerder only: any other role makes no request and starts no timer.
        if (!isBeheerder) return;
        const init = async () => {
             // Initialize isActive field for existing configs (backward compatibility migration)
             let needsSave = false;
             dbStore.update(curr => {
                 if (curr.configurations) {
                     curr.configurations = curr.configurations.map(c => {
                         if (c.id === 'notas') return c; // Skip the notas folder
                         if (c.isActive === undefined) {
                             needsSave = true;
                             return { ...c, isActive: true };
                         }
                         return c;
                     });
                 }
                 return { ...curr };
             });
             if (needsSave) {
                 saveDB();
             }

             await fetchBackendConfigs();
             await fetchAgentDefaults();
             await fetchAiModels();
        };
        init();

        refreshInterval = setInterval(() => fetchBackendConfigs(false), 10000);

        return () => {
            if (refreshInterval) clearInterval(refreshInterval);
        };
    });

    // Watch for config selection changes
    $: if (selectedConfigId) {
        fetchConfigSubfolders(selectedConfigId);
        if (backendConfigIds.includes(selectedConfigId)) {
            fetchConfigMetadata(selectedConfigId);
        }
    }

    // the stored woordenlijst is read on selection, not only when its tab opens, so that a save carries it.
    $: if (selectedConfigId) { loadStoredWoordenlijst(selectedConfigId); }

    // Watch for tab changes to load data - only for existing backend configs
    $: if (
        selectedConfigId &&
        configTab &&
        configTab !== 'b1-parameters' &&
        backendConfigIds.includes(selectedConfigId)
    ) {
        fetchSubfolderData(selectedConfigId, configTab);
    }

    $: db = $dbStore;
    $: {
        const fromStore = (db.configurations || []).filter(c => c.id !== 'notas').map(c => ({
            ...c,
            isActive: c.isActive !== undefined ? c.isActive : true // Backward compatibility: default to active
        }));
        const storeIds = new Set(fromStore.map(c => c.id));
        const storageOnly = backendConfigIds
            .filter(id => !storeIds.has(id))
            .map(id => ({
                id,
                name: id,
                templateVersion: '1.0',
                description: 'Found in storage but no local metadata.',
                rules: [],
                templateGuidelines: [],
                isActive: true
            }));
        configurations = [...fromStore, ...storageOnly];
    }
    $: selectedConfig = configurations.find(c => c.id === selectedConfigId);

    // Split configurations into synced (live) and local groups
    $: syncedConfigs = configurations.filter(c => backendConfigIds.includes(c.id));
    $: localConfigs = configurations.filter(c => !backendConfigIds.includes(c.id));

    let workingConfig = null;
    let initialConfigId = null;
    let newWordInput = '';
    let wordJsonInput = '';
    let wordJsonError = '';
    let showWordList = true;
    /** Set of guideline ids that are expanded in the accordion. */
    let expandedSections = new Set();

    /** Beheer form for `b1Guidelines` (synced when selecting another config). */
    let b1AdminForm = formFieldsFromMergedGuidelines(mergeB1Guidelines(null));
    let b1AdminFormSyncedId = null;

    // When the selected config changes significantly (different ID), we create a fresh clone
    // The clone is taken once per selected id, and the stored woordenlijst is merged into it
    // by `loadStoredWoordenlijst` and a save waits for that merge, so "Opslaan naar Storage" no longer deletes the woordenlijst blobs.
    // App.svelte waits for the page-level load before it shows this view.
    $: if (selectedConfig && selectedConfig.id !== initialConfigId) {
        workingConfig = JSON.parse(JSON.stringify(selectedConfig));
        // Ensure defaults for properties
        if (!workingConfig.toneOfVoice) workingConfig.toneOfVoice = 'Zakelijk';
        if (workingConfig.isActive === undefined) workingConfig.isActive = true;
        initialConfigId = selectedConfig.id;
        const gs = workingConfig.templateGuidelines || [];
        expandedSections = gs.length > 0 ? new Set([gs[gs.length - 1].id]) : new Set();
    } else if (selectedConfig && !workingConfig) {
        workingConfig = JSON.parse(JSON.stringify(selectedConfig));
        // Ensure defaults for properties
        if (!workingConfig.toneOfVoice) workingConfig.toneOfVoice = 'Zakelijk';
        if (workingConfig.isActive === undefined) workingConfig.isActive = true;
        initialConfigId = selectedConfig.id;
        const gs = workingConfig.templateGuidelines || [];
        expandedSections = gs.length > 0 ? new Set([gs[gs.length - 1].id]) : new Set();
    }

    $: if (workingConfig && workingConfig.id !== b1AdminFormSyncedId) {
        b1AdminFormSyncedId = workingConfig.id;
        b1AdminForm = formFieldsFromMergedGuidelines(mergeB1Guidelines(workingConfig.b1Guidelines));
    }

    /** Schrijft `b1AdminForm` naar `workingConfig.b1Guidelines`; retourneert false bij validatiefout. */
    function syncB1GuidelinesFromForm() {
        if (!workingConfig) return false;
        try {
            workingConfig.b1Guidelines = b1GuidelinesFromFormFields(b1AdminForm);
            return true;
        } catch (e) {
            addNotification(e instanceof Error ? e.message : String(e), 'error', 8000);
            return false;
        }
    }

    /** Schrijft het formulier naar `workingConfig.b1Guidelines` en slaat lokaal op. */
    function applyB1GuidelinesFromForm() {
        if (!syncB1GuidelinesFromForm()) return;
        updateConfig();
    }

    /** Verwijdert org-overrides (productstandaard). */
    function resetB1GuidelinesOverrides() {
        if (!workingConfig) return;
        delete workingConfig.b1Guidelines;
        b1AdminForm = formFieldsFromMergedGuidelines(mergeB1Guidelines(null));
        updateConfig();
    }

    /** Vult het formulier met het ingebouwde voorbeeld (nog niet opgeslagen tot u Toepassen kiest). */
    function loadB1AdminExample() {
        b1AdminForm = formFieldsFromMergedGuidelines(mergeB1Guidelines(getB1GuidelinesAdminExample()));
    }

    function addB1GlobalSourceRow() {
        b1AdminForm.globalSources = [...b1AdminForm.globalSources, { label: '', url: '', note: '' }];
        b1AdminForm = b1AdminForm;
    }

    function removeB1GlobalSourceRow(index) {
        if (b1AdminForm.globalSources.length <= 1) {
            b1AdminForm.globalSources = [{ label: '', url: '', note: '' }];
        } else {
            b1AdminForm.globalSources = b1AdminForm.globalSources.filter((_, j) => j !== index);
        }
        b1AdminForm = b1AdminForm;
    }

    /** @param {string} metricKey */
    function addB1MetricSourceRow(metricKey) {
        const m = b1AdminForm.metrics[metricKey];
        m.sources = [...m.sources, { label: '', url: '', note: '' }];
        b1AdminForm = b1AdminForm;
    }

    /** @param {string} metricKey */
    function removeB1MetricSourceRow(metricKey, index) {
        const m = b1AdminForm.metrics[metricKey];
        if (m.sources.length <= 1) {
            m.sources = [{ label: '', url: '', note: '' }];
        } else {
            m.sources = m.sources.filter((_, j) => j !== index);
        }
        b1AdminForm = b1AdminForm;
    }

    // We also need to refresh workingConfig if fetchSubfolderData loads new data for the current tab,
    // but without disrupting typing in other tabs. For safety, we only completely overwrite workingConfig
    // if the user switches configs. If they are in the middle of typing, we rely on the subfolder fetch
    // naturally completing when they change tabs.

    /** Persists `workingConfig` into `dbStore` and calls `saveDB()`. */
    function updateConfig() {
        if (!workingConfig) return;
        // Push workingConfig back to dbStore
        dbStore.update(curr => {
            if (!curr.configurations) curr.configurations = [];
            const idx = curr.configurations.findIndex(c => c.id === workingConfig.id);
            if (idx !== -1) {
                curr.configurations[idx] = JSON.parse(JSON.stringify(workingConfig));
            } else {
                curr.configurations.push(JSON.parse(JSON.stringify(workingConfig)));
            }
            return { ...curr };
        });
        saveDB();
    }

    /**
     * Standaardinstructies van de backend (`GET /agent-defaults`), per opdracht. De backend gebruikt ze als het veld
     * van een hoofdstuk leeg is; de beheeromgeving toont ze bij dat lege veld en kan ze overnemen.
     * @type {Record<string, string>}
     */
    let agentDefaults = {};

    async function fetchAgentDefaults() {
        try {
            const response = await storageFetch(`/agent-defaults`, readInit());
            if (!response.ok) return;
            const data = await response.json();
            const instructions = data && typeof data === 'object' ? data.instructions : null;
            if (instructions && typeof instructions === 'object') {
                agentDefaults = Object.fromEntries(
                    Object.entries(instructions).filter(([, v]) => typeof v === 'string' && v.trim())
                );
            }
        } catch {
            // zonder standaardtekst blijft het veld gewoon bewerkbaar; alleen de hint ontbreekt
        }
    }

    /**
     * The models a beheerder can choose per configuratie, kop and opdracht (`GET /ai-models`, LiteLLM `/v1/models` via the
     * backend; the LiteLLM key never reaches the browser). Not selectable with Foundry: then every call uses AI_MODEL.
     */
    let aiModelInfo = normaliseModelInfo(null);
    let aiModelInfoLoaded = false;

    async function fetchAiModels() {
        try {
            const response = await storageFetch(`/ai-models`, readInit());
            if (destroyed) return;
            if (!response.ok) {
                aiModelInfo = { ...normaliseModelInfo(null), error: 'De lijst met modellen kon niet worden opgehaald.' };
                return;
            }
            aiModelInfo = normaliseModelInfo(await response.json());
        } catch (error) {
            if (isAbort(error)) return;
            aiModelInfo = { ...normaliseModelInfo(null), error: 'De lijst met modellen kon niet worden opgehaald.' };
        } finally {
            if (!destroyed) aiModelInfoLoaded = true;
        }
    }

    /** The model list for checking a choice, or null when it could not be fetched (then a stored choice is trusted). */
    $: availableModels = aiModelInfo.selectable && !aiModelInfo.error ? aiModelInfo.models : null;

    /** Stores a model choice on the configuration (`holder` = workingConfig) or a kop, and saves locally. */
    function chooseModel(holder, task, value) {
        setChoice(holder, task, value);
        workingConfig = workingConfig;
        updateConfig();
    }

    // The rows of the model blocks. The configuration and the model info are passed in (not read from the closure), so
    // Svelte redraws the rows when either changes.
    const std = (model) => `Standaard (${model || 'onbekend'})`;

    /** Rows of the block at the top of an onderdeel (Hoofdstukken, B1-parameters, Woordenlijst). */
    function sectionRows(section, config, info, available) {
        return (SECTION_MODEL_TASKS[section] || []).map((t) => ({
            task: t.key,
            label: t.label,
            inheritLabel: std(inheritedModel('configuratie-opdracht', t.key, null, config, info.defaultModel, available))
        }));
    }

    /** Rows of the block on Eigenschappen: the model for everything, and the two opdrachten for the whole nota. */
    function propertyRows(config, info, available) {
        return [
            { task: null, label: 'Standaardmodel', inheritLabel: `Systeemstandaard (${info.defaultModel || 'onbekend'})` },
            ...NOTA_MODEL_TASKS.map((t) => ({
                task: t.key,
                label: t.label,
                inheritLabel: std(inheritedModel('configuratie-opdracht', t.key, null, config, info.defaultModel, available))
            }))
        ];
    }

    const KOP_DEFAULT_ROW = [{ task: null, label: 'Model voor deze kop', inheritLabel: 'Zoals ingesteld bij de onderdelen' }];

    /** Per-taak rows of a kop (optional refinement). */
    function kopTaskRows(chapter, config, info, available) {
        return CHAPTER_MODEL_TASKS.map((t) => ({
            task: t.key,
            label: t.label,
            inheritLabel: std(inheritedModel('kop-opdracht', t.key, chapter, config, info.defaultModel, available))
        }));
    }

    /** Ids of the koppen whose "Eigen AI-model" switch is on while nothing is chosen yet. */
    let ownModelKoppen = new Set();

    /** The switch of a kop: off removes every model choice of that kop, so it follows the onderdelen again. */
    function toggleOwnModel(chapter, on) {
        const next = new Set(ownModelKoppen);
        if (on) {
            next.add(chapter.id);
        } else {
            next.delete(chapter.id);
            clearChoices(chapter);
            workingConfig = workingConfig;
            updateConfig();
        }
        ownModelKoppen = next;
    }

    /** True when a kop has a per-taak choice, so its "Per taak" part opens by itself. */
    function hasTaskChoice(chapter) {
        const tasks = chapter && chapter[MODELS_KEY] && chapter[MODELS_KEY].opdrachten;
        return !!tasks && Object.values(tasks).some((v) => typeof v === 'string' && v.trim());
    }

    /** True when an instruction field is empty, so the backend uses its default text. */
    function isEmptyInstruction(value) {
        return typeof value !== 'string' || !value.trim();
    }

    /** Toggles the active/inactive state of a configuration. */
    async function toggleConfigActiveState(configId, event) {
        event.stopPropagation(); // Prevent config selection when clicking toggle
        let newIsActive = true;
        dbStore.update(curr => {
            if (!curr.configurations) return curr;
            const config = curr.configurations.find(c => c.id === configId);
            if (config) {
                config.isActive = !config.isActive;
                newIsActive = config.isActive;
                // If this is the currently selected config, update workingConfig too
                if (workingConfig && workingConfig.id === configId) {
                    workingConfig.isActive = config.isActive;
                }
            }
            return { ...curr };
        });
        saveDB();

        if (backendConfigIds.includes(configId)) {
            try {
                const response = await storageFetch(`/configurations/${encodeURIComponent(configId)}/metadata`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ isActive: newIsActive })
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                console.error(`Failed to persist isActive for ${configId}:`, error);
                addNotification(/HTTP 40[13]/.test(String(error)) ? SESSION_OR_ROLE_MESSAGE('Kon actieve status niet opslaan in storage') : 'Kon actieve status niet opslaan in storage', 'error', 8000);
            }
        }
    }

    /** Persists isActive to metadata.json for configs already in blob storage. */
    async function persistIsActiveToStorage(configId, isActive) {
        if (!backendConfigIds.includes(configId)) return;
        try {
            const response = await storageFetch(`/configurations/${encodeURIComponent(configId)}/metadata`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isActive })
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            console.error(`Failed to persist isActive for ${configId}:`, error);
            addNotification(/HTTP 40[13]/.test(String(error)) ? SESSION_OR_ROLE_MESSAGE('Kon actieve status niet opslaan in storage') : 'Kon actieve status niet opslaan in storage', 'error', 8000);
        }
    }

    /** Checkbox handler for the Eigenschappen tab — local + blob when synced. */
    function handleIsActiveChange() {
        if (!workingConfig) return;
        updateConfig();
        persistIsActiveToStorage(workingConfig.id, workingConfig.isActive);
    }

    /**
     * Adds a placeholder rule (category, severity, trigger words).
     * The rule goes into the working copy that the tabs render and the save sends.
     */
    function addRule(category) {
        if (!selectedConfigId || !workingConfig) return;
        workingConfig.rules = [...(workingConfig.rules || []), {
            id: 'r' + Date.now(),
            category,
            severity: 'yellow',
            triggerWords: ['nieuw'],
            alternatives: ['beter'],
            explanation: 'Nieuwe regel.'
        }];
        updateConfig();
    }

    /** Removes one rule from `workingConfig` by id. */
    function removeRule(ruleId) {
        if (!workingConfig) return;
        workingConfig.rules = workingConfig.rules.filter(r => r.id !== ruleId);
        updateConfig();
    }

    /** Adds one or more words (comma/newline separated) to the woordenlijst. */
    function addWord() {
        if (!newWordInput.trim() || !workingConfig) return;
        const words = newWordInput.split(/[\n,\s]+/).map(w => w.trim()).filter(Boolean);
        if (!workingConfig.woordenlijst) workingConfig.woordenlijst = [];
        workingConfig.woordenlijst = [...new Set([...workingConfig.woordenlijst, ...words])];
        updateConfig();
        newWordInput = '';
    }

    /** Removes a word from the woordenlijst by index. */
    function removeWord(index) {
        if (!workingConfig) return;
        workingConfig.woordenlijst = workingConfig.woordenlijst.filter((_, i) => i !== index);
        updateConfig();
    }

    /** Imports words from a JSON array, comma-separated, or newline-separated string. */
    function importWordsFromJson() {
        wordJsonError = '';
        const raw = wordJsonInput.trim();
        if (!raw) return;

        let words = [];
        // Try JSON first
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) { wordJsonError = 'Verwacht een JSON array, bijv. ["woord1", "woord2"]'; return; }
            words = parsed.map(w => String(w).trim()).filter(Boolean);
        } catch {
            // Fall back: split on commas and/or newlines
            words = raw.split(/[\n,\s]+/).map(w => w.trim()).filter(Boolean);
        }

        if (!workingConfig.woordenlijst) workingConfig.woordenlijst = [];
        workingConfig.woordenlijst = [...new Set([...workingConfig.woordenlijst, ...words])];
        updateConfig();
        wordJsonInput = '';
    }

    /** Renumbers guideline ids to `h1`, `h2`, … after delete or sort. */
    function reindexGuidelines(guidelines) {
        return (guidelines || []).map((g, index) => ({
            ...g,
            id: 'h' + (index + 1)
        }));
    }

    /** Appends an empty string to a guideline array field (e.g. `vereisten`). */
    function addListItem(guideline, field) {
        guideline[field] = [...(guideline[field] || []), ''];
        updateConfig();
    }

    /** Removes the item at `index` from a guideline array field. */
    function removeListItem(guideline, field, index) {
        guideline[field] = guideline[field].filter((_, i) => i !== index);
        updateConfig();
    }

    /** Appends a new empty chapter template to `workingConfig` (see `addRule`). */
    function addSection() {
        if (!workingConfig) return;
        if (!workingConfig.templateGuidelines) workingConfig.templateGuidelines = [];

        const nextId = 'h' + (workingConfig.templateGuidelines.length + 1);
        const newGuideline = {
            id: nextId,
            titel: '',
            doel: '',
            vereisten: [],
            voorbeelden: [],
            fout_voorbeelden: [],
            instructie: '',
            agent_spelling_grammatica: '',
            agent_open_overheid: '',
            agent_structuur_output_template: '',
            agent_spelling_grammatica_output_template: '',
            agent_b1_output_template: '',
            agent_woordenlijst: '',
            agent_woordenlijst_output_template: '',
            agent_digitale_toegankelijkheid_output_template: '',
            agent_open_overheid_output_template: ''
        };

        workingConfig.templateGuidelines = [...workingConfig.templateGuidelines, newGuideline];
        expandedSections = new Set([nextId]);
        updateConfig();
    }

    /** Asks for the typed confirmation of removing a section (the typed-confirmation modal). */
    function removeSection(id) {
        if (!workingConfig) return;
        sectionIdToDelete = id;
    }

    /** Removes the confirmed section and reindexes the remainder. */
    function handleSectionDeleteConfirm() {
        const id = sectionIdToDelete;
        sectionIdToDelete = null;
        if (!workingConfig || id === null) return;
        workingConfig.templateGuidelines = workingConfig.templateGuidelines.filter(g => g.id !== id);
        workingConfig.templateGuidelines = reindexGuidelines(workingConfig.templateGuidelines);
        updateConfig();
    }

    /** Downloads `selectedConfig` as `.json` in the browser. */
    function exportConfigToJson() {
        if (!selectedConfig) return;
        const blob = new Blob([JSON.stringify(selectedConfig, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFileName(selectedConfig.name);
        // The anchor lives in the container, never in the host's `document.body`.
        const host = rootEl || document.body;
        host.appendChild(a);
        a.click();
        host.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /** Triggers the hidden file input for JSON import. */
    function importConfigFromJson() {
        if (fileInputRef) fileInputRef.click();
    }

    /** Reads JSON (flat or storage-style *mappen* wrap) and adds a new configuration to the store. */
    function handleFileImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        const input = event.target;

        // a file that cannot be a configuration is refused before it is read (the v5 export is about 136 kB).
        if (file.size > MAX_IMPORT_BYTES) {
            addNotification('Fout bij het importeren van JSON: het bestand is te groot (maximaal 10 MB).', 'error', 8000);
            input.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                // The shape of the file is checked and mapped in adminConfig.js (storage format and flat export).
                // the depth is checked on the text before it is parsed, the size of the content after (parseImportText).
                const newConfig = configFromImport(parseImportText(String(e.target.result)), naturalSort);

                db.configurations = [...(db.configurations || []), newConfig];
                selectedConfigId = newConfig.id;
                updateConfig();
                addNotification('Configuratie succesvol geïmporteerd!', 'success');
            } catch (err) {
                addNotification('Fout bij het importeren van JSON: ' + (err instanceof Error ? err.message : String(err)), 'error', 8000);
            }
        };
        reader.onerror = () => addNotification('Fout bij het importeren van JSON: het bestand kon niet worden gelezen.', 'error', 8000);
        reader.readAsText(file);
        input.value = ''; // Reset for same file re-import
    }

    /** POSTs full config to `/upload-configuration`; may delete old folder when id/name changes. */
    async function saveToStorage() {
        if (!selectedConfigId || !workingConfig) return;
        try {
            // B1-parameters tab edits live in b1AdminForm until synced into workingConfig
            if (!syncB1GuidelinesFromForm()) return;

            // the id is the blob folder that the backend wipes and rebuilds; an unusable id stops here, before anything is sent.
            const idCheck = validateConfigId(workingConfig.id);
            if (!idCheck.ok) {
                addNotification(`Opslaan mislukt: ${idCheck.reason}`, 'error', 8000);
                return;
            }

            // the ids of the chapters and rules become file names; checked before the old folder is deleted (rename flow).
            const itemProblem = workingConfigItemProblem(workingConfig);
            if (itemProblem) {
                addNotification(`Opslaan mislukt: ${itemProblem}`, 'error', 8000);
                return;
            }

            // a synced configuration is never saved before its stored woordenlijst is in the working copy.
            if (!(await loadStoredWoordenlijst(selectedConfigId))) {
                addNotification('Opslaan mislukt: de woordenlijst van deze configuratie kon niet worden geladen. Probeer het opnieuw.', 'error', 8000);
                return;
            }

            // First update local so we know workingConfig is synced
            updateConfig();

            // Use the id field as the folder identifier, not the name
            const currentId = idCheck.id;
            const oldId = selectedConfigId;

            // If the ID changed, delete the old folder in storage
            if (oldId !== currentId && backendConfigIds.includes(oldId)) {
                try {
                    await storageFetch(`/configurations/${encodeURIComponent(oldId)}`, {
                        method: 'DELETE'
                    });
                    console.log(`Deleted old configuration folder: ${oldId}`);
                } catch (err) {
                    console.warn(`Could not delete old configuration folder ${oldId}:`, err);
                }
            }

            // Construct the expected backend format (`b1Guidelines` → metadata.json via storage service); the folder key is `currentId`
            const payload = buildUploadPayload(workingConfig, currentId);

            const response = await storageFetch(`/upload-configuration`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 401 || response.status === 403) {
                addNotification(SESSION_OR_ROLE_MESSAGE('Opslaan mislukt'), 'error', 8000);
                return;
            }
            const result = await response.json();
            if (result.status === 'success') {
                addNotification(`Configuratie '${workingConfig.name}' succesvol opgeslagen in storage!`, 'success');

                // If the ID changed, remove the old entry from local store to prevent duplicates
                if (oldId !== currentId) {
                    dbStore.update(curr => {
                        if (curr.configurations) {
                            curr.configurations = curr.configurations.filter(c => c.id !== oldId);
                        }
                        return { ...curr };
                    });
                }

                // Update identifiers to match new id
                wordlistLoadedFor = currentId; // what was just saved is the stored woordenlijst
                workingConfig.id = currentId;
                selectedConfigId = currentId;
                updateConfig();

                fetchBackendConfigs(); // Refresh list
            } else {
                addNotification(`Fout bij opslaan: ${typeof result.detail === 'string' ? result.detail : 'Onbekende fout'}`, 'error', 8000);
            }
        } catch (error) {
            console.error('Save failed:', error);
            addNotification('Opslaan mislukt. Controleer de console.', 'error', 8000);
        }
    }

    /** Creates a new local configuration with sample rule and chapter and selects it. */
    function addNewConfig() {
        const newId = 'conf-' + Date.now();
        const newConfig = {
            id: newId,
            name: 'Nieuwe Configuratie',
            description: 'Beschrijf de toepassing van deze configuratie.',
            templateVersion: '1.0',
            toneOfVoice: 'Zakelijk',
            allowedWords: [],
            isActive: true,
            rules: [
                {
                    id: 'r1-' + Date.now(),
                    category: 'B1 Taal',
                    severity: 'yellow',
                    triggerWords: ['attenderen'],
                    alternatives: ['laten weten'],
                    explanation: 'Maak het eenvoudiger voor de lezer.'
                }
            ],
            templateGuidelines: [
                {
                    id: 'h1',
                    titel: 'Onderwerp kort en duidelijk weergeven',
                    doel: 'De lezer begrijpt direct, zonder enige voorkennis, waar het GS-voorstel over gaat.',
                    vereisten: [
                        'Hanteer een korte onderwerptitel (richtlijn: maximaal vijf woorden)',
                        'In het onderwerp geen ‘beslispunt’ opnemen',
                        'In het onderwerp geen werkwoord opnemen'
                    ],
                    voorbeelden: ['Aanbesteding bouw parkeergarage provinciehuis'],
                    fout_voorbeelden: ['Nota besluit over subsidieverlening 2024 – 2027'],
                    instructie: 'Schrijf hier een korte, krachtige titel.',
                    agent_structuur: 'jij bent een agent die de structuur op deze manier goed bekijkt en aan de hand van de vereisten een titel formuleert die kort en duidelijk het onderwerp weergeeft. De titel mag maximaal vijf woorden bevatten, en mag geen werkwoord of beslispunt bevatten.',
                    agent_spelling_grammatica:
                        'Jij bent een taalreviewagent voor de overheid. Controleer de tekst grondig op spelling, grammatica en interpunctie volgens de officiële norm (o.a. Groene Boekje, Taaladvies.net). Signaleer ook subtiele fouten: spaties vóór of na leestekens, twee of meer spaties achter elkaar tussen woorden (geen dubbele spatie), inconsistente komma’s, lichte grammatica en woordkeuze — niet alleen opvallende spelfouten. Gebruik een lege Suggesties-lijst alleen als de tekst redactioneel correct is. Geef per bevinding een kort fragment (Origineel) dat letterlijk uit de brontekst komt, een concrete verbetering (Suggestie) en een duidelijke Uitleg (regel of norm). Antwoord uitsluitend als JSON: {"Suggesties": [{"Origineel": "…", "Suggestie": "…", "Uitleg": "…"}, …]}.',
                    agent_b1: 'Jij bent een B1-niveau taalcoach voor de overheid. Controleer de tekst op spelling, grammatica en interpunctie volgens de officiële norm (Groene Boekje, Schrijfwijzer van Jan Renkema en Taaladvies.net). Detecteer spelfouten, inconsequente vervoegingen en interpunctiefouten. Geef concrete verbeteringen en een korte uitleg. Gebruik het volgende JSON formaat voor je antwoord: {"Suggesties": [{"Origineel": "het originele onjuiste of ingewikkelde tekstfragment", "Suggestie": "de verbeterde tekst voor dit fragment", "Uitleg": "uitleg van de toegepaste regels"}]}. Richt je op helderheid, eenvoud en correctheid. Geef voor elke verbetering een apart object in de lijst terug.',
                    agent_digitale_toegankelijkheid: 'Zorg dat de titel ook goed leesbaar is voor mensen met een visuele beperking, bijvoorbeeld door het vermijden van jargon and het gebruik van duidelijke taal.',
                    agent_open_overheid: 'Zorg dat de titel transparant is en direct aangeeft waar het voorstel over gaat, zodat burgers en andere belanghebbenden gemakkelijk kunnen begrijpen wat er op het spel staat.',
                    agent_structuur_output_template: '{\n  "titel": "string"\n}',
                    agent_spelling_grammatica_output_template:
                        '{\n  "Suggesties": [\n    {\n      "Origineel": "string",\n      "Suggestie": "string",\n      "Uitleg": "string"\n    }\n  ]\n}',
                    agent_b1_output_template: '{\n  "Suggesties": [\n    {\n      "Origineel": "string",\n      "Suggestie": "string",\n      "Uitleg": "string"\n    }\n  ]\n}',
                    agent_digitale_toegankelijkheid_output_template: '',
                    agent_open_overheid_output_template: ''
                }
            ]
        };

        db.configurations = [...db.configurations, newConfig];
        selectedConfigId = newId;
        updateConfig();
    }

    /**
     * Number of notas that use this configuration, or null when that cannot be found out. The notas in the store are
     * only there after the dashboard has loaded them, and a beheerder who lands on the configurator has none, so the nota list is read from
     * storage on the delete click, joined with the notas that exist only locally; a failed read refuses the delete (fail closed).
     * `GET /notas` returns every nota blob; it is one call per delete click.
     */
    async function getConfigUsageCount(configId) {
        let remote = [];
        try {
            const res = await storageFetch(`/notas`, readInit());
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || !Array.isArray(data.notas)) return null;
            remote = data.notas;
        } catch (e) {
            return null;
        }
        const seen = new Map();
        for (const nota of [...($dbStore.notas || []), ...remote]) {
            if (nota && nota.configId === configId) seen.set(nota.id ?? Symbol(), true);
        }
        return seen.size;
    }

    /** Opens the secure delete confirmation modal. */
    async function removeConfig(id, name, event) {
        if (event) event.stopPropagation();

        // Find the config to check its state
        const config = configurations.find(c => c.id === id);

        // Check if config is active
        if (config && config.isActive) {
            addNotification(
                `Configuratie '${name}' kan niet verwijderd worden: deze is nog actief. Markeer eerst als inactief.`,
                'error'
            );
            return;
        }

        // Check if config is in use by any notas (read from storage now, fail closed)
        const usageCount = await getConfigUsageCount(id);
        if (destroyed) return;
        if (usageCount === null) {
            addNotification(
                `Configuratie '${name}' kan niet verwijderd worden: er kon niet worden gecontroleerd of nota's deze configuratie nog gebruiken. Probeer het later opnieuw.`,
                'error',
                8000
            );
            return;
        }
        if (usageCount > 0) {
            addNotification(
                `Configuratie '${name}' kan niet verwijderd worden: deze wordt nog gebruikt door ${usageCount} nota${usageCount > 1 ? "s" : ""}. Verwijder eerst alle gekoppelde nota's of koppel ze aan een andere configuratie.`,
                'error'
            );
            return;
        }

        // If checks pass, proceed with deletion
        configIdToDelete = id;
        configNameToDelete = name || id;
        showDeleteConfirm = true;
    }

    /** The actual deletion logic, called after the user confirms in the modal. */
    async function handleDeleteConfirm() {
        const id = configIdToDelete;
        showDeleteConfirm = false;

        // 1. If it's a backend config, delete from storage
        if (backendConfigIds.includes(id)) {
            try {
                const response = await storageFetch(`/configurations/${encodeURIComponent(id)}`, {
                    method: 'DELETE'
                });
                if (response.ok) {
                    // Update the backend IDs list immediately
                    backendConfigIds = backendConfigIds.filter(bid => bid !== id);
                } else {
                    // a refused delete keeps the row and is reported below.
                    console.error("Failed to delete from storage: HTTP", response.status);
                    addNotification(
                        response.status === 401 || response.status === 403
                            ? SESSION_OR_ROLE_MESSAGE('Verwijderen mislukt')
                            : `Verwijderen mislukt: de configuratie '${configNameToDelete}' staat nog in storage.`,
                        'error',
                        8000
                    );
                    configIdToDelete = null;
                    configNameToDelete = "";
                    return;
                }
            } catch (err) {
                console.error("Error deleting from storage:", err);
                addNotification(`Verwijderen mislukt: de configuratie '${configNameToDelete}' staat mogelijk nog in storage.`, 'error', 8000);
                configIdToDelete = null;
                configNameToDelete = "";
                return;
            }
        }

        // 2. Delete from local store
        dbStore.update(curr => {
            if (curr.configurations) {
                curr.configurations = curr.configurations.filter(c => c.id !== id);
            }
            return { ...curr };
        });

        // 3. Update selection if needed
        if (selectedConfigId === id) {
            // Clear workingConfig so it's not re-added by updateConfig
            workingConfig = null;
            initialConfigId = null;

            // Re-evaluate list after both local and backend updates
            const currentDb = get(dbStore);
            const remaining = [...(currentDb.configurations || []), ...backendConfigIds.map(bid => ({id: bid}))];
            selectedConfigId = remaining[0]?.id || null;
        }

        // 4. Save to persistent storage (localStorage)
        // If we still have a workingConfig (deleted something else), updateConfig will save it.
        // Otherwise, saveDB just persists the deletion.
        if (workingConfig) {
            updateConfig();
        } else {
            saveDB();
        }

        addNotification(`Configuratie '${configNameToDelete}' succesvol verwijderd.`, 'success');
        configIdToDelete = null;
        configNameToDelete = "";
    }

    /** Turns comma-separated input into an array of trimmed non-empty strings on `guideline[field]`. */
    function handleArrayInput(guideline, field, value) {
        guideline[field] = value.split(',').map(s => s.trim()).filter(s => s !== '');
        updateConfig();
    }
</script>

{#if !isBeheerder}
    <!-- The configurator is for a beheerder only; App.svelte never shows this view to another role, this is the second line. -->
    <div class="main-content sa-stub-view" data-admin-denied="true">
        <div class="sa-stub-card">
            <i class="ph-bold ph-lock-key sa-stub-icon" aria-hidden="true"></i>
            <h2>Geen toegang</h2>
            <p>De configurator is alleen beschikbaar voor beheerders.</p>
        </div>
    </div>
{:else}
<div class={'sa-admin-dashboard-admin-dashboard'}>
    <div class={'sa-admin-dashboard-admin-sidebar'}>
        <div class={'sa-admin-dashboard-admin-sidebar-header'}>
            <i class="ph-bold ph-shield-star"></i>
            Beheer
        </div>
        <nav class={'sa-admin-dashboard-admin-nav'}>
            <button class="{'sa-admin-dashboard-admin-nav-item'} {activeTab === 'configurator' ? 'sa-admin-dashboard-active' : ''}" on:click={() => activeTab = 'configurator'}>
                <i class="ph-bold ph-gear"></i> Configurator
            </button>
        </nav>

    </div>

    <div class={'sa-admin-dashboard-admin-content'}>
        {#if activeTab === 'configurator'}
            <div class={'sa-admin-dashboard-configurator-layout'}>
                <div class={'sa-admin-dashboard-config-selector'}>
                    <div class={'sa-admin-dashboard-selector-header'}>
                        <h2>Configuraties</h2>
                        <div class={'sa-admin-dashboard-header-actions'}>
                            <button
                                type="button"
                                class="sa-btn-icon {configListSyncing ? 'sa-admin-dashboard-spinning' : ''}"
                                on:click={() => fetchBackendConfigs(true)}
                                disabled={configListSyncing}
                                title="Configuraties synchroniseren met storage"
                                aria-label="Configuraties synchroniseren met storage"
                            >
                                <i class="ph-bold ph-arrows-clockwise" aria-hidden="true"></i>
                            </button>
                            <button class="sa-btn-icon" on:click={addNewConfig} title="Nieuwe configuratie toevoegen" aria-label="Nieuwe configuratie toevoegen">
                                <i class="ph-bold ph-plus-circle" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <div class={'sa-admin-dashboard-config-list-header'}>
                        <span>Naam</span>
                        <span>Actief</span>
                        <span>Verwijderen</span>
                    </div>
                    <div class={'sa-admin-dashboard-config-list'}>
                        <!-- Synced (Live) Configurations -->
                        {#each syncedConfigs as config}
                            <div
                                class="{'sa-admin-dashboard-config-selection-item'} {selectedConfigId === config.id ? 'sa-admin-dashboard-active' : ''} config-item-synced {!config.isActive ? 'config-inactive' : ''}"
                                on:click={() => {
                                    selectedConfigId = config.id;
                                }}
                                role="button"
                                tabindex="0"
                                on:keydown={(e) => e.key === 'Enter' && (selectedConfigId = config.id)}
                            >
                                <div class={'sa-admin-dashboard-selection-item-content'}>
                                    <div class={'sa-admin-dashboard-name'}>
                                        {config.name}
                                        <i class="ph ph-cloud" style="color: #3b82f6; margin-left: 4px;" title="Gesynchroniseerd met cloud"></i>
                                    </div>
                                </div>
                                <div class={'sa-admin-dashboard-config-item-actions'}>
                                    <button
                                        class="{'sa-admin-dashboard-btn-item-toggle'} {config.isActive ? 'sa-admin-dashboard-toggle-active' : 'sa-admin-dashboard-toggle-inactive'}"
                                        on:click={(e) => toggleConfigActiveState(config.id, e)}
                                        title={config.isActive ? 'Markeer als inactief' : 'Markeer als actief'}
                                        aria-label={config.isActive ? 'Markeer als inactief' : 'Markeer als actief'}
                                    >
                                        <i class="ph-bold {config.isActive ? 'ph-toggle-right' : 'ph-toggle-left'}" aria-hidden="true"></i>
                                    </button>
                                    <button class={'sa-admin-dashboard-btn-item-del'} on:click={(e) => removeConfig(config.id, config.name, e)} title="Configuratie verwijderen" aria-label="Configuratie verwijderen">
                                        <i class="ph ph-trash" aria-hidden="true"></i>
                                    </button>
                                </div>
                            </div>
                        {/each}

                        <!-- Divider between synced and local -->
                        {#if syncedConfigs.length > 0 && localConfigs.length > 0}
                            <div class={'sa-admin-dashboard-config-list-divider'}>
                                <span class={'sa-admin-dashboard-divider-text'}>lokale configuraties</span>
                            </div>
                        {/if}

                        <!-- Local (Unsynced) Configurations -->
                        {#each localConfigs as config}
                            <div
                                class="{'sa-admin-dashboard-config-selection-item'} {selectedConfigId === config.id ? 'sa-admin-dashboard-active' : ''} {'sa-admin-dashboard-config-item-local'} {!config.isActive ? 'config-inactive' : ''}"
                                on:click={() => {
                                    selectedConfigId = config.id;
                                }}
                                role="button"
                                tabindex="0"
                                on:keydown={(e) => e.key === 'Enter' && (selectedConfigId = config.id)}
                            >
                                <div class={'sa-admin-dashboard-selection-item-content'}>
                                    <div class={'sa-admin-dashboard-name'}>
                                        {config.name}
                                    </div>
                                </div>
                                <div class={'sa-admin-dashboard-config-item-actions'}>
                                    <button
                                        class="{'sa-admin-dashboard-btn-item-toggle'} {config.isActive ? 'sa-admin-dashboard-toggle-active' : 'sa-admin-dashboard-toggle-inactive'}"
                                        on:click={(e) => toggleConfigActiveState(config.id, e)}
                                        title={config.isActive ? 'Markeer als inactief' : 'Markeer als actief'}
                                        aria-label={config.isActive ? 'Markeer als inactief' : 'Markeer als actief'}
                                    >
                                        <i class="ph-bold {config.isActive ? 'ph-toggle-right' : 'ph-toggle-left'}" aria-hidden="true"></i>
                                    </button>
                                    <button class={'sa-admin-dashboard-btn-item-del'} on:click={(e) => removeConfig(config.id, config.name, e)} title="Configuratie verwijderen" aria-label="Configuratie verwijderen">
                                        <i class="ph ph-trash" aria-hidden="true"></i>
                                    </button>
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>

                <div class={'sa-admin-dashboard-config-editor'}>
                    {#if workingConfig}
                        <div class={'sa-admin-dashboard-editor-header'}>
                            <div class="header-main">
                                <div class={'sa-admin-dashboard-title-group'}>
                                    <input class={'sa-admin-dashboard-title-input'} bind:value={workingConfig.name} on:blur={updateConfig} />
                                    {#if backendConfigIds.includes(workingConfig.id)}
                                        <i class="ph ph-cloud" style="color: #3b82f6; font-size: 1.2rem; margin-right: 8px;" title="Opgeslagen in cloud storage"></i>
                                    {/if}

                                    <div class={'sa-admin-dashboard-version-tag'}>
                                        <i class="ph ph-tag"></i>
                                        <input bind:value={workingConfig.templateVersion} on:blur={updateConfig} />
                                    </div>
                                    <button class="sa-btn sa-btn-secondary" on:click={exportConfigToJson}>
                                        <i class="ph ph-download"></i> Exporteer
                                    </button>
                                    <button class="sa-btn sa-btn-secondary" on:click={importConfigFromJson}>
                                        <i class="ph ph-upload"></i> Importeer
                                    </button>
                                    <input
                                        type="file"
                                        accept=".json"
                                        bind:this={fileInputRef}
                                        on:change={handleFileImport}
                                        style="display: none;"
                                    />
                                    <button class="sa-btn sa-btn-primary" on:click={saveToStorage}>
                                        <i class="ph ph-cloud-arrow-up"></i> Opslaan naar Storage
                                    </button>
                                </div>
                                <div class={'sa-admin-dashboard-config-tabs'}>
                                    {#each backendSubfolders as subfolder}
                                        <button
                                            class="{'sa-admin-dashboard-tab-btn'} {configTab === subfolder ? 'sa-admin-dashboard-active' : ''}"
                                            on:click={() => configTab = subfolder}
                                        >
                                            {configTabLabel(subfolder)}
                                        </button>
                                    {/each}
                                </div>
                            </div>
                        </div>

                        <div class={'sa-admin-dashboard-editor-body'}>
                            {#if backendSubfolders.length > 0}
                                {#if configTab === 'hoofdstukken' || configTab === 'templates'}
                                    <div class="section-container">
                                        <div class={'sa-admin-dashboard-section-header'}>
                                            <h3>Template Structuur</h3>
                                            <button class="sa-btn sa-btn-primary sa-btn-sm" on:click={addSection}><i class="ph ph-plus"></i> Sectie</button>
                                        </div>
                                        {#if aiModelInfo.selectable}
                                            <AiModelCard
                                                title="AI-model voor de hoofdstukken"
                                                intro="Welk AI-model controleert de structuur en de spelling van de hoofdstukken? Twijfel je, laat het dan op Standaard staan. Wil één kop iets anders, zet dan bij die kop Eigen AI-model aan."
                                                idPrefix="section-model-hoofdstukken"
                                                rows={sectionRows('hoofdstukken', workingConfig, aiModelInfo, availableModels)}
                                                holder={workingConfig}
                                                info={aiModelInfo}
                                                available={availableModels}
                                                onchoose={(task, value) => chooseModel(workingConfig, task, value)}
                                            />
                                        {/if}
                                        <div class="template-grid">
                                            {#each workingConfig.templateGuidelines || [] as guideline, i}
                                                {@const isExpanded = expandedSections.has(guideline.id)}
                                                <div class={'sa-admin-dashboard-admin-template-card'}>
                                                    <div
                                                        class={'sa-admin-dashboard-card-bar'}
                                                        role="button"
                                                        tabindex="0"
                                                        style="cursor: pointer"
                                                        on:click={() => {
                                                            const next = new Set(expandedSections);
                                                            if (next.has(guideline.id)) next.delete(guideline.id);
                                                            else next.add(guideline.id);
                                                            expandedSections = next;
                                                        }}
                                                        on:keydown={(e) => e.key === 'Enter' && (() => {
                                                            const next = new Set(expandedSections);
                                                            if (next.has(guideline.id)) next.delete(guideline.id);
                                                            else next.add(guideline.id);
                                                            expandedSections = next;
                                                        })()}
                                                    >
                                                        <i class="ph-bold {isExpanded ? 'ph-caret-down' : 'ph-caret-right'}" style="color: var(--sa-text-muted); font-size: 0.8rem; flex-shrink: 0"></i>
                                                        <span class={'sa-admin-dashboard-idx'}>{guideline.id}</span>
                                                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                                                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                                                        <input bind:value={guideline.titel} on:blur={updateConfig} placeholder="Hoofdstuktitel..." on:click|stopPropagation />
                                                        <button class={'sa-admin-dashboard-btn-del'} on:click|stopPropagation={() => removeSection(guideline.id)} aria-label="Sectie verwijderen"><i class="ph ph-trash" aria-hidden="true"></i></button>
                                                    </div>
                                                    {#if isExpanded}
                                                    <div class={'sa-admin-dashboard-card-content'}>
                                                        <div class={'sa-admin-dashboard-field-row'}>
                                                            <div class={'sa-admin-dashboard-field'}>
                                                                <label for="inst-{guideline.id}">Instructie</label>
                                                                <input id="inst-{guideline.id}" bind:value={guideline.instructie} on:blur={updateConfig} placeholder="Bv: Schrijf hier..." />
                                                            </div>
                                                            <div class={'sa-admin-dashboard-field'}>
                                                                <label for="doel-{guideline.id}">Doel van de sectie</label>
                                                                <input id="doel-{guideline.id}" bind:value={guideline.doel} on:blur={updateConfig} placeholder="Bv: De lezer begrijpt direct..." />
                                                            </div>
                                                        </div>

                                                        <div class={'sa-admin-dashboard-field-row'}>
                                                            <div class={'sa-admin-dashboard-field'}>
                                                                <label>Vereisten</label>
                                                                <div class={'sa-admin-dashboard-list-container'}>
                                                                    {#each guideline.vereisten || [] as v, idx}
                                                                        <div class={'sa-admin-dashboard-list-item'}>
                                                                            <input bind:value={guideline.vereisten[idx]} on:blur={updateConfig} placeholder="Voeg vereiste toe..." />
                                                                            <button class={'sa-admin-dashboard-btn-item-del'} on:click={() => removeListItem(guideline, 'vereisten', idx)}><i class="ph ph-minus-circle"></i></button>
                                                                        </div>
                                                                    {/each}
                                                                    <button class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-mt-1'}" on:click={() => addListItem(guideline, 'vereisten')}><i class="ph ph-plus"></i> Vereiste toevoegen</button>
                                                                </div>
                                                            </div>
                                                            <div class={'sa-admin-dashboard-field'}></div>
                                                        </div>

                                                        <div class={'sa-admin-dashboard-field-row'}>
                                                            <div class={'sa-admin-dashboard-field'}>
                                                                <label>Goede voorbeelden</label>
                                                                <div class={'sa-admin-dashboard-list-container'}>
                                                                    {#each guideline.voorbeelden || [] as ex, idx}
                                                                        <div class={'sa-admin-dashboard-list-item'}>
                                                                            <input bind:value={guideline.voorbeelden[idx]} on:blur={updateConfig} placeholder="Bv: Aanbesteding bouw..." />
                                                                            <button class={'sa-admin-dashboard-btn-item-del'} on:click={() => removeListItem(guideline, 'voorbeelden', idx)}><i class="ph ph-minus-circle"></i></button>
                                                                        </div>
                                                                    {/each}
                                                                    <button class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-mt-1'}" on:click={() => addListItem(guideline, 'voorbeelden')}><i class="ph ph-plus"></i> Voorbeeld toevoegen</button>
                                                                </div>
                                                            </div>
                                                            <div class={'sa-admin-dashboard-field'}>
                                                                <label>Foute voorbeelden</label>
                                                                <div class={'sa-admin-dashboard-list-container'}>
                                                                    {#each guideline.fout_voorbeelden || [] as ex, idx}
                                                                        <div class={'sa-admin-dashboard-list-item'}>
                                                                            <input bind:value={guideline.fout_voorbeelden[idx]} on:blur={updateConfig} placeholder="Bv: Nota besluit over..." />
                                                                            <button class={'sa-admin-dashboard-btn-item-del'} on:click={() => removeListItem(guideline, 'fout_voorbeelden', idx)}><i class="ph ph-minus-circle"></i></button>
                                                                        </div>
                                                                    {/each}
                                                                    <button class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-mt-1'}" on:click={() => addListItem(guideline, 'fout_voorbeelden')}><i class="ph ph-plus"></i> Fout voorbeeld toevoegen</button>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {#if aiModelInfo.selectable}
                                                            {@const ownOn = hasOwnModels(guideline) || ownModelKoppen.has(guideline.id)}
                                                            <div class="{'sa-admin-dashboard-mt-4'} {'sa-admin-dashboard-pt-4'} {'sa-admin-dashboard-border-t'}">
                                                                <label class={'sa-admin-dashboard-ai-switch'}>
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={ownOn}
                                                                        on:change={(e) => toggleOwnModel(guideline, e.currentTarget.checked)}
                                                                    />
                                                                    <span><i class="ph ph-sparkle" aria-hidden="true"></i> Eigen AI-model voor deze kop</span>
                                                                </label>
                                                                {#if !ownOn}
                                                                    <p class={'sa-admin-dashboard-agent-default-hint'}>Uit: deze kop gebruikt de AI-modellen die bij de onderdelen zijn ingesteld.</p>
                                                                {:else}
                                                                    <AiModelCard
                                                                        compact
                                                                        idPrefix="model-{guideline.id}"
                                                                        rows={KOP_DEFAULT_ROW}
                                                                        holder={guideline}
                                                                        info={aiModelInfo}
                                                                        available={availableModels}
                                                                        onchoose={(task, value) => chooseModel(guideline, task, value)}
                                                                    >
                                                                        <details class={'sa-admin-dashboard-ai-card-more'} open={hasTaskChoice(guideline)}>
                                                                            <summary>Per taak instellen (optioneel)</summary>
                                                                            <AiModelCard
                                                                                compact
                                                                                idPrefix="model-{guideline.id}"
                                                                                rows={kopTaskRows(guideline, workingConfig, aiModelInfo, availableModels)}
                                                                                holder={guideline}
                                                                                info={aiModelInfo}
                                                                                available={availableModels}
                                                                                onchoose={(task, value) => chooseModel(guideline, task, value)}
                                                                            />
                                                                        </details>
                                                                    </AiModelCard>
                                                                {/if}
                                                            </div>
                                                        {/if}

                                                        <div class="agent-fields {'sa-admin-dashboard-mt-4'} {'sa-admin-dashboard-pt-4'} {'sa-admin-dashboard-border-t'}">
                                                            <label class={'sa-admin-dashboard-section-sub-label'}>AI Agent Instructies</label>
                                                            <div class="{'sa-admin-dashboard-field'} {'sa-admin-dashboard-mt-2'}">
                                                                <label for="struct-{guideline.id}">Structuur</label>
                                                                <textarea id="struct-{guideline.id}" bind:value={guideline.agent_structuur} on:blur={updateConfig} placeholder="Jij bent een agent die..."></textarea>
                                                                <label class={'sa-admin-dashboard-mt-1'} for="struct-template-{guideline.id}" style="text-transform: none; opacity: 0.7;">JSON Output Validatie (Optioneel)</label>
                                                                <textarea class={'sa-admin-dashboard-template-textarea'} id="struct-template-{guideline.id}" bind:value={guideline.agent_structuur_output_template} on:blur={updateConfig} placeholder={'{"key": "value"}'}></textarea>
                                                            </div>
                                                            <div class="{'sa-admin-dashboard-field'} {'sa-admin-dashboard-mt-2'}">
                                                                <label for="spell-{guideline.id}">Spelling <span class={'sa-admin-dashboard-agent-label-hint'}>(spelling, grammatica en leestekens)</span></label>
                                                                <textarea id="spell-{guideline.id}" bind:value={guideline.agent_spelling_grammatica} on:blur={updateConfig} placeholder={agentDefaults.agent_spelling_grammatica || 'Jij bent een taalreviewagent die...'}></textarea>
                                                                {#if isEmptyInstruction(guideline.agent_spelling_grammatica)}
                                                                    <p class={'sa-admin-dashboard-agent-default-hint'} role="note">
                                                                        Dit veld is leeg: de Schrijfassistent gebruikt dan de standaardinstructie{agentDefaults.agent_spelling_grammatica ? ' (grijs in het veld)' : ''}.
                                                                        {#if agentDefaults.agent_spelling_grammatica}
                                                                            <button
                                                                                type="button"
                                                                                class="sa-btn sa-btn-secondary sa-btn-sm"
                                                                                on:click={() => {
                                                                                    guideline.agent_spelling_grammatica = agentDefaults.agent_spelling_grammatica;
                                                                                    updateConfig();
                                                                                }}><i class="ph ph-pencil-simple"></i> Standaardtekst overnemen en aanpassen</button>
                                                                        {/if}
                                                                    </p>
                                                                {/if}
                                                                <p class={'sa-admin-dashboard-agent-default-hint'}>Het antwoordformaat (JSON met Suggesties) voegt de Schrijfassistent zelf toe; beschrijf hier alleen waarop gecontroleerd wordt.</p>
                                                                <label class={'sa-admin-dashboard-mt-1'} for="spell-template-{guideline.id}" style="text-transform: none; opacity: 0.7;">JSON Output Validatie (Optioneel)</label>
                                                                <textarea class={'sa-admin-dashboard-template-textarea'} id="spell-template-{guideline.id}" bind:value={guideline.agent_spelling_grammatica_output_template} on:blur={updateConfig} placeholder={'{"key": "value"}'}></textarea>
                                                            </div>
                                                            <div class="{'sa-admin-dashboard-field'} {'sa-admin-dashboard-mt-2'}">
                                                                <label for="b1-{guideline.id}">Direct Duidelijk</label>
                                                                <textarea id="b1-{guideline.id}" bind:value={guideline.agent_b1} on:blur={updateConfig} placeholder="Helder en begrijpelijk taalgebruik toepassen..."></textarea>
                                                                <label class={'sa-admin-dashboard-mt-1'} for="b1-template-{guideline.id}" style="text-transform: none; opacity: 0.7;">JSON Output Validatie (Optioneel)</label>
                                                                <textarea class={'sa-admin-dashboard-template-textarea'} id="b1-template-{guideline.id}" bind:value={guideline.agent_b1_output_template} on:blur={updateConfig} placeholder={'{"key": "value"}'}></textarea>
                                                            </div>
                                                            <div class="{'sa-admin-dashboard-field'} {'sa-admin-dashboard-mt-2'}">
                                                                <label for="acc-{guideline.id}">Digitale Toegankelijkheid</label>
                                                                <textarea id="acc-{guideline.id}" bind:value={guideline.agent_digitale_toegankelijkheid} on:blur={updateConfig} placeholder="Zorg dat de titel ook..."></textarea>
                                                                <label class={'sa-admin-dashboard-mt-1'} for="acc-template-{guideline.id}" style="text-transform: none; opacity: 0.7;">JSON Output Validatie (Optioneel)</label>
                                                                <textarea class={'sa-admin-dashboard-template-textarea'} id="acc-template-{guideline.id}" bind:value={guideline.agent_digitale_toegankelijkheid_output_template} on:blur={updateConfig} placeholder={'{"key": "value"}'}></textarea>
                                                            </div>
                                                            <div class="{'sa-admin-dashboard-field'} {'sa-admin-dashboard-mt-2'}">
                                                                <label for="open-{guideline.id}">Open Overheid</label>
                                                                <textarea id="open-{guideline.id}" bind:value={guideline.agent_open_overheid} on:blur={updateConfig} placeholder="Zorg dat de titel transparant..."></textarea>
                                                                <label class={'sa-admin-dashboard-mt-1'} for="open-template-{guideline.id}" style="text-transform: none; opacity: 0.7;">JSON Output Validatie (Optioneel)</label>
                                                                <textarea class={'sa-admin-dashboard-template-textarea'} id="open-template-{guideline.id}" bind:value={guideline.agent_open_overheid_output_template} on:blur={updateConfig} placeholder={'{"key": "value"}'}></textarea>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    {/if}
                                                </div>
                                            {/each}
                                        </div>
                                    </div>
                                {:else if configTab === 'b1-parameters'}
                                    <div class="section-container">
                                        <div class="{'sa-admin-dashboard-section-header'} {'sa-admin-dashboard-b1-section-header'}">
                                            <h3>B1-parameters</h3>
                                            <div class={'sa-admin-dashboard-b1-form-top-actions'}>
                                                <button type="button" class="sa-btn sa-btn-primary sa-btn-sm" on:click={applyB1GuidelinesFromForm}>
                                                    Opslaan in configuratie
                                                </button>
                                                <button type="button" class="sa-btn sa-btn-secondary sa-btn-sm" on:click={loadB1AdminExample}>
                                                    Voorbeeld laden
                                                </button>
                                                <button type="button" class="sa-btn sa-btn-secondary sa-btn-sm" on:click={resetB1GuidelinesOverrides}>
                                                    Wis overrides (productstandaard)
                                                </button>
                                            </div>
                                        {#if aiModelInfo.selectable}
                                            <AiModelCard
                                                title="AI-model voor Direct Duidelijk"
                                                intro="De meters hieronder rekent de Schrijfassistent zelf uit, zonder AI. Dit AI-model maakt de Direct Duidelijk-suggesties (helder en begrijpelijk schrijven)."
                                                idPrefix="section-model-b1-parameters"
                                                rows={sectionRows('b1-parameters', workingConfig, aiModelInfo, availableModels)}
                                                holder={workingConfig}
                                                info={aiModelInfo}
                                                available={availableModels}
                                                onchoose={(task, value) => chooseModel(workingConfig, task, value)}
                                            />
                                        {/if}
                                        </div>
                                        <div class={'sa-admin-dashboard-b1-guidelines-panel'}>
                                            <p class={'sa-admin-dashboard-b1-guidelines-hint'}>
                                                Deze waarden gaan naar <code>metadata.json</code> bij <strong>Opslaan naar Storage</strong>.
                                                Ze sturen de B1-indicator in de schrijfapp (zeven vaste metrieken). Uitleg:
                                                <strong>b1-metrics</strong> (MkDocs).
                                            </p>

                                            <div class={'sa-admin-dashboard-b1-form-section'}>
                                                <h4 class={'sa-admin-dashboard-b1-guidelines-title'}>Algemeen</h4>
                                                <div class="{'sa-admin-dashboard-b1-form-grid'} {'sa-admin-dashboard-b1-form-grid--2'}">
                                                    <div class={'sa-admin-dashboard-b1-field'}>
                                                        <label for="b1-preset-label">Preset-label <span class={'sa-admin-dashboard-b1-field-hint'}>(in het B1-paneel)</span></label>
                                                        <input
                                                            id="b1-preset-label"
                                                            type="text"
                                                            bind:value={b1AdminForm.presetLabel}
                                                            placeholder="Bijv. Provincie — schrijfgids 2026"
                                                        />
                                                    </div>
                                                    <div class="{'sa-admin-dashboard-b1-field'} {'sa-admin-dashboard-b1-field--full'}">
                                                        <label for="b1-source-note">Toelichting voor auteurs</label>
                                                        <textarea
                                                            id="b1-source-note"
                                                            class={'sa-admin-dashboard-b1-textarea-sm'}
                                                            rows="2"
                                                            bind:value={b1AdminForm.sourceNote}
                                                            placeholder="Korte uitleg die bovenaan het uitleg-paneel verschijnt."
                                                        ></textarea>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class={'sa-admin-dashboard-b1-form-section'}>
                                                <h4 class={'sa-admin-dashboard-b1-guidelines-title'}>Algemene bronnen</h4>
                                                <p class="{'sa-admin-dashboard-b1-guidelines-hint'} {'sa-admin-dashboard-b1-guidelines-hint--tight'}">
                                                    Optioneel: links die voor alle parameters gelden (bijv. intranet-handleiding).
                                                </p>
                                                {#each b1AdminForm.globalSources as gRow, gi}
                                                    <div class={'sa-admin-dashboard-b1-source-block'}>
                                                        <div class="{'sa-admin-dashboard-b1-form-grid'} {'sa-admin-dashboard-b1-form-grid--3'}">
                                                            <div class={'sa-admin-dashboard-b1-field'}>
                                                                <label for="b1-glbl-l-{gi}">Titel</label>
                                                                <input id="b1-glbl-l-{gi}" type="text" bind:value={gRow.label} placeholder="Naam bron" />
                                                            </div>
                                                            <div class={'sa-admin-dashboard-b1-field'}>
                                                                <label for="b1-glbl-u-{gi}">URL</label>
                                                                <input id="b1-glbl-u-{gi}" type="url" bind:value={gRow.url} placeholder="https://…" />
                                                            </div>
                                                            <div class={'sa-admin-dashboard-b1-field'}>
                                                                <label for="b1-glbl-n-{gi}">Noot</label>
                                                                <input id="b1-glbl-n-{gi}" type="text" bind:value={gRow.note} placeholder="Optioneel" />
                                                            </div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-b1-row-remove'}"
                                                            on:click={() => removeB1GlobalSourceRow(gi)}
                                                            aria-label="Rij verwijderen"
                                                        >
                                                            Verwijder rij
                                                        </button>
                                                    </div>
                                                {/each}
                                                <button type="button" class="sa-btn sa-btn-secondary sa-btn-sm" on:click={addB1GlobalSourceRow}>
                                                    <i class="ph ph-plus"></i> Bron toevoegen
                                                </button>
                                            </div>

                                            {#each B1_ADMIN_METRIC_ROWS as row}
                                                {@const m = b1AdminForm.metrics[row.key]}
                                                <div class={'sa-admin-dashboard-b1-metric-card'}>
                                                    <div class={'sa-admin-dashboard-b1-metric-card-head'}>
                                                        <h4 class={'sa-admin-dashboard-b1-metric-title'}>{row.label}</h4>
                                                        <code class="{'sa-admin-dashboard-b1-metric-key'} {'sa-admin-dashboard-mono'}">{row.key}</code>
                                                    </div>
                                                    <p class={'sa-admin-dashboard-b1-metric-how'}>{row.howComputed}</p>
                                                    <div class="{'sa-admin-dashboard-b1-form-grid'} {'sa-admin-dashboard-b1-form-grid--bands'}">
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-g0">Goed: van</label>
                                                            <input
                                                                id="b1-{row.key}-g0"
                                                                type="number"
                                                                step="any"
                                                                bind:value={m.goodLo}
                                                            />
                                                        </div>
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-g1">Goed: tot</label>
                                                            <input
                                                                id="b1-{row.key}-g1"
                                                                type="number"
                                                                step="any"
                                                                bind:value={m.goodHi}
                                                                placeholder={m.direction === 'higher' ? 'leeg = ∞' : ''}
                                                            />
                                                        </div>
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-w0">Waarschuwing: van</label>
                                                            <input
                                                                id="b1-{row.key}-w0"
                                                                type="number"
                                                                step="any"
                                                                bind:value={m.warnLo}
                                                            />
                                                        </div>
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-w1">Waarschuwing: tot</label>
                                                            <input
                                                                id="b1-{row.key}-w1"
                                                                type="number"
                                                                step="any"
                                                                bind:value={m.warnHi}
                                                            />
                                                        </div>
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-tgt">Doel (tekst op chip)</label>
                                                            <input id="b1-{row.key}-tgt" type="text" bind:value={m.target} />
                                                        </div>
                                                        <div class={'sa-admin-dashboard-b1-field'}>
                                                            <label for="b1-{row.key}-dir">Richting</label>
                                                            <select id="b1-{row.key}-dir" bind:value={m.direction}>
                                                                <option value="lower">Lager is beter</option>
                                                                <option value="higher">Hoger is beter</option>
                                                            </select>
                                                        </div>
                                                    </div>
                                                    {#if m.direction === 'higher'}
                                                        <p class="{'sa-admin-dashboard-b1-guidelines-hint'} {'sa-admin-dashboard-b1-guidelines-hint--tight'}">
                                                            Bij <strong>hoger is beter</strong>: laat <em>Goed: tot</em> leeg voor geen bovengrens.
                                                        </p>
                                                    {/if}
                                                    <h5 class={'sa-admin-dashboard-b1-sources-title'}>Bronnen voor deze parameter</h5>
                                                    {#each m.sources as sRow, si}
                                                        <div class={'sa-admin-dashboard-b1-source-block'}>
                                                            <div class="{'sa-admin-dashboard-b1-form-grid'} {'sa-admin-dashboard-b1-form-grid--3'}">
                                                                <div class={'sa-admin-dashboard-b1-field'}>
                                                                    <label for="b1-{row.key}-sl-{si}">Titel</label>
                                                                    <input id="b1-{row.key}-sl-{si}" type="text" bind:value={sRow.label} />
                                                                </div>
                                                                <div class={'sa-admin-dashboard-b1-field'}>
                                                                    <label for="b1-{row.key}-su-{si}">URL</label>
                                                                    <input id="b1-{row.key}-su-{si}" type="url" bind:value={sRow.url} />
                                                                </div>
                                                                <div class={'sa-admin-dashboard-b1-field'}>
                                                                    <label for="b1-{row.key}-sn-{si}">Noot</label>
                                                                    <input id="b1-{row.key}-sn-{si}" type="text" bind:value={sRow.note} />
                                                                </div>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-b1-row-remove'}"
                                                                on:click={() => removeB1MetricSourceRow(row.key, si)}
                                                                aria-label="Bron verwijderen"
                                                            >
                                                                Verwijder rij
                                                            </button>
                                                        </div>
                                                    {/each}
                                                    <button
                                                        type="button"
                                                        class="sa-btn sa-btn-secondary sa-btn-sm"
                                                        on:click={() => addB1MetricSourceRow(row.key)}
                                                    >
                                                        <i class="ph ph-plus"></i> Bron toevoegen
                                                    </button>
                                                </div>
                                            {/each}

                                            <div class="{'sa-admin-dashboard-b1-guidelines-actions'} {'sa-admin-dashboard-b1-guidelines-actions--footer'}">
                                                <button type="button" class="sa-btn sa-btn-primary sa-btn-sm" on:click={applyB1GuidelinesFromForm}>
                                                    Opslaan in configuratie
                                                </button>
                                                <button type="button" class="sa-btn sa-btn-secondary sa-btn-sm" on:click={resetB1GuidelinesOverrides}>
                                                    Wis overrides (productstandaard)
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                {:else if configTab === 'terminologie' || configTab === 'terms'}
                                    <div class="section-container">
                                        <div class={'sa-admin-dashboard-section-header'}>
                                            <h3>Verboden Terminologie</h3>
                                            <button class="sa-btn sa-btn-primary sa-btn-sm" on:click={() => addRule('Terminologie')}><i class="ph ph-plus"></i> Term</button>
                                        </div>
                                        {#if aiModelInfo.selectable}
                                            <p class={'sa-admin-dashboard-ai-none'}><i class="ph ph-info" aria-hidden="true"></i> Dit onderdeel gebruikt geen AI: de controle gebeurt direct in de editor. Je hoeft hier dus geen AI-model te kiezen.</p>
                                        {/if}
                                        <!-- `bind:value` on an array field shows "a,b" and, on the first edit, stores the typed STRING in `triggerWords` / `alternatives`;
                                             the save sends that string. The sidebar reads such a string as a comma list (adminConfig.js). -->
                                        <table class={'sa-admin-dashboard-admin-table'}>
                                            <thead>
                                                <tr><th>Verboden</th><th>Alternatief</th><th>Acties</th></tr>
                                            </thead>
                                            <tbody>
                                                {#each (workingConfig.rules || []).filter(r => r.category === 'Terminologie') as rule}
                                                    <tr>
                                                        <td><input bind:value={rule.triggerWords} on:blur={updateConfig} /></td>
                                                        <td><input bind:value={rule.alternatives} on:blur={updateConfig} /></td>
                                                        <td><button class="text-red" on:click={() => removeRule(rule.id)} aria-label="Verwijder regel"><i class="ph ph-trash" aria-hidden="true"></i></button></td>
                                                    </tr>
                                                {/each}
                                            </tbody>
                                        </table>
                                    </div>
                                {:else if configTab === 'regels' || configTab === 'rules'}
                                    <div class="section-container">
                                        <div class={'sa-admin-dashboard-section-header'}>
                                            <h3>B1 Taalregels</h3>
                                            <button class="sa-btn sa-btn-primary sa-btn-sm" on:click={() => addRule('B1 Taal')}><i class="ph ph-plus"></i> Regel</button>
                                        </div>
                                        {#if aiModelInfo.selectable}
                                            <p class={'sa-admin-dashboard-ai-none'}><i class="ph ph-info" aria-hidden="true"></i> Dit onderdeel gebruikt geen AI: de controle gebeurt direct in de editor. Je hoeft hier dus geen AI-model te kiezen.</p>
                                        {/if}
                                        <!-- `bind:value` on an array field shows "a,b" and, on the first edit, stores the typed STRING in `triggerWords` / `alternatives`;
                                             the save sends that string. The sidebar reads such a string as a comma list (adminConfig.js). -->
                                        <table class={'sa-admin-dashboard-admin-table'}>
                                            <thead>
                                                <tr><th>Trigger</th><th>B1 Alternatief</th><th>Acties</th></tr>
                                            </thead>
                                            <tbody>
                                                {#each (workingConfig.rules || []).filter(r => r.category !== 'Terminologie') as rule}
                                                    <tr>
                                                        <td><input bind:value={rule.triggerWords} on:blur={updateConfig} /></td>
                                                        <td><input bind:value={rule.alternatives} on:blur={updateConfig} /></td>
                                                        <td><button class="text-red" on:click={() => removeRule(rule.id)} aria-label="Verwijder regel"><i class="ph ph-trash" aria-hidden="true"></i></button></td>
                                                    </tr>
                                                {/each}
                                            </tbody>
                                        </table>
                                    </div>
                                {:else if configTab === 'eigenschappen'}
                                    <div class="section-container">
                                        <div class={'sa-admin-dashboard-section-header'}>
                                            <h3>Configuratie Eigenschappen</h3>
                                        </div>
                                        <div class={'sa-admin-dashboard-properties-form'}>
                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label for="config-id">
                                                    Uniek ID
                                                    <span class={'sa-admin-dashboard-help-text'}>(Folder naam in blob storage - wijzig met voorzichtigheid)</span>
                                                </label>
                                                <input
                                                    id="config-id"
                                                    type="text"
                                                    bind:value={workingConfig.id}
                                                    on:blur={updateConfig}
                                                    placeholder="bijv. conf-gs"
                                                />
                                            </div>

                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label for="config-name">
                                                    Naam
                                                    <span class={'sa-admin-dashboard-help-text'}>(Weergave naam voor gebruikers)</span>
                                                </label>
                                                <input
                                                    id="config-name"
                                                    type="text"
                                                    bind:value={workingConfig.name}
                                                    on:blur={updateConfig}
                                                    placeholder="bijv. Gemeenteraadsstuk"
                                                />
                                            </div>

                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label for="config-version">Template Versie</label>
                                                <input
                                                    id="config-version"
                                                    type="text"
                                                    bind:value={workingConfig.templateVersion}
                                                    on:blur={updateConfig}
                                                    placeholder="bijv. 2.0"
                                                />
                                            </div>

                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label for="config-description">Beschrijving</label>
                                                <textarea
                                                    id="config-description"
                                                    bind:value={workingConfig.description}
                                                    on:blur={updateConfig}
                                                    placeholder="Korte beschrijving van deze configuratie"
                                                    rows="3"
                                                ></textarea>
                                            </div>

                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label for="config-tone">Toon van Stemming</label>
                                                <select
                                                    id="config-tone"
                                                    bind:value={workingConfig.toneOfVoice}
                                                    on:change={updateConfig}
                                                >
                                                    <option value="Zakelijk">Zakelijk</option>
                                                    <option value="Formeel">Formeel</option>
                                                    <option value="Informeel">Informeel</option>
                                                    <option value="Vriendelijk">Vriendelijk</option>
                                                </select>
                                            </div>

                                            <div class={'sa-admin-dashboard-form-group'}>
                                                <label>
                                                    <input
                                                        type="checkbox"
                                                        bind:checked={workingConfig.isActive}
                                                        on:change={handleIsActiveChange}
                                                    />
                                                    Actief (toon in configuratie keuzemenu)
                                                </label>
                                            </div>

                                            {#if aiModelInfo.selectable}
                                                <AiModelCard
                                                    title="AI-model van deze configuratie"
                                                    intro="Het standaardmodel geldt voor alles waar je bij een onderdeel of kop niets anders kiest. Titel en samenvatting gelden voor de hele nota."
                                                    idPrefix="config-model"
                                                    rows={propertyRows(workingConfig, aiModelInfo, availableModels)}
                                                    holder={workingConfig}
                                                    info={aiModelInfo}
                                                    available={availableModels}
                                                    onchoose={(task, value) => chooseModel(workingConfig, task, value)}
                                                >
                                                    {@const ownKoppen = chaptersWithOwnModels(workingConfig.templateGuidelines)}
                                                    {#if ownKoppen.length}
                                                        <p class={'sa-admin-dashboard-ai-card-intro'}>Koppen met een eigen AI-model:</p>
                                                        <ul class={'sa-admin-dashboard-model-overrides'}>
                                                            {#each ownKoppen as kop}
                                                                <li><strong>{kop.id}{kop.titel ? ` ${kop.titel}` : ''}</strong>: {kop.choices.join(', ')}</li>
                                                            {/each}
                                                        </ul>
                                                    {/if}
                                                </AiModelCard>
                                            {:else if aiModelInfoLoaded && aiModelInfo.defaultModel}
                                                <p class={'sa-admin-dashboard-help-text'}>AI-model: {aiModelInfo.defaultModel}. Een ander model kiezen kan alleen als de Schrijfassistent via LiteLLM werkt.</p>
                                            {/if}

                                            <div class={'sa-admin-dashboard-properties-info'}>
                                                <i class="ph ph-info"></i>
                                                <div>
                                                    <strong>Let op:</strong> Wijzigen van het Uniek ID heeft invloed op de folder structuur in blob storage.
                                                    Bestaande configuraties moeten handmatig worden verplaatst in storage.
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                {:else if configTab === 'woordenlijst'}
                                    <div class="section-container">
                                        <div class={'sa-admin-dashboard-section-header'}>
                                            <h3>B1 Woordenlijst</h3>
                                            <span class="text-muted" style="font-size:0.8rem">{(workingConfig.woordenlijst || []).length} woorden</span>
                                        </div>
                                        {#if aiModelInfo.selectable}
                                            <AiModelCard
                                                title="AI-model voor de woordenlijst"
                                                intro="Dit AI-model zoekt moeilijke of vage woorden in de tekst en stelt eenvoudiger woorden voor."
                                                idPrefix="section-model-woordenlijst"
                                                rows={sectionRows('woordenlijst', workingConfig, aiModelInfo, availableModels)}
                                                holder={workingConfig}
                                                info={aiModelInfo}
                                                available={availableModels}
                                                onchoose={(task, value) => chooseModel(workingConfig, task, value)}
                                            />
                                        {/if}

                                        <div class={'sa-admin-dashboard-word-add-row'}>
                                            <input
                                                class={'sa-admin-dashboard-word-input'}
                                                bind:value={newWordInput}
                                                placeholder="Woord toevoegen..."
                                                on:keydown={(e) => e.key === 'Enter' && addWord()}
                                            />
                                            <button class="sa-btn sa-btn-primary sa-btn-sm" on:click={addWord}><i class="ph ph-plus"></i> Toevoegen</button>
                                        </div>

                                        <div class={'sa-admin-dashboard-word-list-container'}>
                                            <button class={'sa-admin-dashboard-word-list-toggle'} on:click={() => showWordList = !showWordList}>
                                                <i class="ph-bold {showWordList ? 'ph-caret-down' : 'ph-caret-right'}"></i>
                                                {showWordList ? 'Verberg lijst' : 'Toon lijst'}
                                                <span class={'sa-admin-dashboard-word-count-badge'}>{(workingConfig.woordenlijst || []).length}</span>
                                            </button>
                                            {#if showWordList}
                                                {#if !(workingConfig.woordenlijst || []).length}
                                                    <p class="text-muted" style="font-size:0.85rem;padding:8px 0">Nog geen woorden toegevoegd.</p>
                                                {:else}
                                                    <div class={'sa-admin-dashboard-word-list-scroll'}>
                                                        {#each (workingConfig.woordenlijst || []) as word, i}
                                                            <div class={'sa-admin-dashboard-word-list-row'}>
                                                                <span class={'sa-admin-dashboard-word-list-index'}>{i + 1}</span>
                                                                <span class={'sa-admin-dashboard-word-list-label'}>{word}</span>
                                                                <button class={'sa-admin-dashboard-btn-del'} on:click={() => removeWord(i)} aria-label="Verwijder woord"><i class="ph ph-trash" aria-hidden="true"></i></button>
                                                            </div>
                                                        {/each}
                                                    </div>
                                                {/if}
                                            {/if}
                                        </div>

                                        <div class={'sa-admin-dashboard-json-import-section'}>
                                            <label class={'sa-admin-dashboard-section-sub-label'}>Snel importeren via JSON</label>
                                            <p class="text-muted" style="font-size:0.78rem;margin:2px 0 6px">Komma- of regelgescheiden, of JSON array: <code>["woord1", "woord2"]</code></p>
                                            <textarea
                                                class={'sa-admin-dashboard-json-import-textarea'}
                                                bind:value={wordJsonInput}
                                                placeholder={"burger, aanvraag, brief\nof één woord per regel\nof [\"json\", \"array\"]"}
                                                rows="4"
                                            ></textarea>
                                            {#if wordJsonError}<p class={'sa-admin-dashboard-error-msg'}>{wordJsonError}</p>{/if}
                                            <button class="sa-btn sa-btn-secondary sa-btn-sm {'sa-admin-dashboard-mt-1'}" on:click={importWordsFromJson}><i class="ph ph-upload-simple"></i> Importeren</button>
                                        </div>
                                    </div>
                                {:else}
                                    <div class={'sa-admin-dashboard-empty-state'}>
                                        <i class="ph ph-folder"></i>
                                        <p>Deze map ({configTab}) is gevonden in storage, maar heeft nog geen formulier-weergave.</p>
                                    </div>
                                {/if}
                            {:else}
                                <div class={'sa-admin-dashboard-empty-state'}>
                                    <i class="ph ph-warning"></i>
                                    <p>Geen submappen gevonden in storage voor deze configuratie.</p>
                                </div>
                            {/if}
                        </div>
                    {:else}
                        <div class={'sa-admin-dashboard-empty-state'}>
                            <i class="ph ph-selection-all"></i>
                            <p>Selecteer een configuratie om de instellingen te bewerken.</p>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>

    {#if showDeleteConfirm}
        <DeleteConfigModal
            itemName={configNameToDelete}
            itemType="configuratie"
            onConfirm={handleDeleteConfirm}
            onCancel={() => showDeleteConfirm = false}
        />
    {/if}
    {#if sectionIdToDelete !== null}
        <DeleteConfigModal
            itemName={String(sectionIdToDelete)}
            itemType="sectie"
            onConfirm={handleSectionDeleteConfirm}
            onCancel={() => sectionIdToDelete = null}
        />
    {/if}
</div>
{/if}

