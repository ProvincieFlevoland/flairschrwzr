<script>
    /**
     * One block of model choices in the configurator: a title, a short explanation and one list per row. Used at the top of
     * an onderdeel (Hoofdstukken, B1-parameters, Woordenlijst, Eigenschappen) and inside a kop. The first option of every
     * list is "Standaard (...)", which stores nothing, so the choice of the level above applies (src/lib/aiModels.js).
     */
    import { getChoice, modelOptions } from '$lib/aiModels.js';

    export let title = '';
    export let intro = '';
    /** @type {{ task: string | null, label: string, inheritLabel: string }[]} */
    export let rows = [];
    /** The configuration or kop that holds `aiModellen`. */
    export let holder = null;
    /** `normaliseModelInfo(GET /ai-models)`. */
    export let info = { selectable: false, defaultModel: '', models: [], error: '', provider: '' };
    /** The model list, or null when it could not be fetched (then a stored choice is not marked as missing). */
    export let available = null;
    export let idPrefix = 'ai-model';
    /** @type {(task: string | null, value: string) => void} */
    export let onchoose = () => {};
    export let compact = false;

    $: listKnown = Array.isArray(available);

    /** @param {string} model */
    function isMissing(model) {
        return !!model && listKnown && !available.includes(model);
    }
</script>

<div class="{'sa-admin-dashboard-ai-card'} {compact ? 'sa-admin-dashboard-ai-card--compact' : ''}">
    {#if title}
        <div class={'sa-admin-dashboard-ai-card-head'}><i class="ph ph-sparkle" aria-hidden="true"></i><span>{title}</span></div>
    {/if}
    {#if intro}
        <p class={'sa-admin-dashboard-ai-card-intro'}>{intro}</p>
    {/if}
    {#if info.error && !compact}
        <p class={'sa-admin-dashboard-model-warning'} role="note">{info.error} Bestaande keuzes blijven bewaard.</p>
    {/if}
    <div class={'sa-admin-dashboard-ai-card-rows'}>
        {#each rows as row (row.task ?? '__standaard')}
            {@const chosen = getChoice(holder, row.task)}
            <div class={'sa-admin-dashboard-ai-card-row'}>
                <label for="{idPrefix}-{row.task ?? 'standaard'}">{row.label}</label>
                <select
                    id="{idPrefix}-{row.task ?? 'standaard'}"
                    class={'sa-admin-dashboard-model-select'}
                    value={chosen}
                    on:change={(e) => onchoose(row.task, e.currentTarget.value)}
                >
                    <option value="">{row.inheritLabel}</option>
                    {#each modelOptions(info.models, chosen, listKnown) as opt}
                        <option value={opt.value}>{opt.label}</option>
                    {/each}
                </select>
                {#if isMissing(chosen)}
                    <p class={'sa-admin-dashboard-model-warning'} role="note">Dit model is niet meer beschikbaar. De Schrijfassistent gebruikt dan: {row.inheritLabel}.</p>
                {/if}
            </div>
        {/each}
    </div>
    <slot />
</div>
