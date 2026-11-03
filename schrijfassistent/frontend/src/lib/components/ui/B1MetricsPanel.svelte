<script>
    import { safeLinkUrl } from '$lib/utils/safeUrl.js';
    import { b1MetricsDocUrl } from '$lib/config.js';
    import {
        B1_METRIC_KEYS,
        B1_OVERALL_WEIGHTS,
        mergeB1Guidelines,
        getB1MetricStatus,
        formatB1MetricBands,
        DD_OVERALL_WEIGHTS
    } from '$lib/utils/b1Guidelines.js';
    import './B1MetricsPanel.css';

    /** Result of calculateB1ParameterSnapshot or null */
    export let snapshot = null;
    export let cellTitle = '';
    /** Optional org overrides from workspace config (`b1Guidelines`); merged with product defaults. */
    export let b1GuidelinesOverride = undefined;

    /** When set, only these metric keys render as chips (e.g. Direct Duidelijk). Default: all {@link B1_METRIC_KEYS}. */
    export let visibleMetricKeys = null;

    /** When `visibleMetricKeys` is set and this is true, score bar uses {@link DD_OVERALL_WEIGHTS}. */
    export let useDdScoreWeights = false;

    /** Optional panel title override (default: B1-parameters). */
    export let panelTitle = '';

    $: chipKeys =
        visibleMetricKeys != null && Array.isArray(visibleMetricKeys) && visibleMetricKeys.length > 0
            ? visibleMetricKeys
            : B1_METRIC_KEYS;

    $: helpKeys = chipKeys;

    $: scoreWeights = useDdScoreWeights ? DD_OVERALL_WEIGHTS : B1_OVERALL_WEIGHTS;

    /** Optional URL to B1-metrics docs: `config.b1_metrics_doc_url` of the card. */
    const docUrl = b1MetricsDocUrl();

    $: guidelines = mergeB1Guidelines(b1GuidelinesOverride);

    let helpOpen = false;

    /** @param {string} key */
    function formatSuffix(key) {
        if (key === 'passiveSentencePercent' || key === 'activeVoicePercent') return '%';
        return '';
    }

    /** @param {string} key */
    function formatChipValue(key, raw) {
        if (raw == null || raw === '') return '—';
        if (key === 'heldereZinnenScore') return String(Math.round(Number(raw)));
        if (key === 'avgSentencesPerParagraph')
            return Number.isFinite(Number(raw)) ? String(raw) : '—';
        return String(raw);
    }

    /**
     * Derive chip row state in one reactive block so Svelte 5 reliably invalidates on `snapshot` updates
     * (avoid `{@const status = fn()}` + helper that may not register deep snapshot deps).
     */
    $: chipRows =
        snapshot == null
            ? []
            : chipKeys
                  .map((key) => {
                      const def = guidelines.metrics[key];
                      if (!def) return null;
                      const val = snapshot[key];
                      const status = getB1MetricStatus(key, val, def) ?? 'warn';
                      return { key, val, status, def };
                  })
                  .filter(Boolean);

    $: overallScore = (() => {
        if (!snapshot) return null;
        let totalWeight = 0;
        let earned = 0;
        for (const row of chipRows) {
            const { key, status } = row;
            const w = scoreWeights[key];
            if (w == null || row.val == null) continue;
            totalWeight += w;
            if (status === 'good') earned += w;
            else if (status === 'warn') earned += w * 0.5;
        }
        return totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : null;
    })();

    $: scoreLabel =
        overallScore == null
            ? ''
            : overallScore >= 80
              ? 'Goed B1-niveau'
              : overallScore >= 55
                ? 'Redelijk B1-niveau'
                : 'Verbetering nodig';

    $: scoreColor =
        overallScore == null ? 'var(--sa-text-muted)' : overallScore >= 80 ? 'var(--sa-ok-text)' : overallScore >= 55 ? 'var(--sa-warn-text)' : 'var(--sa-color-red-text)';

    const STATUS_LABEL = {
        good: 'binnen richtlijn',
        warn: 'net boven richtlijn',
        bad: 'boven richtlijn'
    };

    const STATUS_COLOR = {
        good: 'var(--sa-ok-text)',
        warn: 'var(--sa-warn-text)',
        bad: 'var(--sa-color-red-text)'
    };

    const STATUS_BG = {
        good: 'rgba(22, 163, 74, 0.07)',
        warn: 'rgba(217, 119, 6, 0.07)',
        bad: 'rgba(220, 38, 38, 0.07)'
    };
</script>

{#if snapshot}
    <div class={'sa-b1-metrics-panel-b1-metrics-panel'}>
        <div class={'sa-b1-metrics-panel-b1-metrics-header'}>
            <i class="ph-bold ph-gauge" style="color: #0b6edb"></i>
            <div>
                <div class={'sa-b1-metrics-panel-b1-metrics-title'}>
                    {panelTitle || 'B1-parameters (indicatief)'}
                </div>
                <div class={'sa-b1-metrics-panel-b1-metrics-sub'}>{cellTitle || 'Actief hoofdstuk'}</div>
                <div class={'sa-b1-metrics-panel-b1-preset-line'}>{guidelines.presetLabel}</div>
            </div>
            <div class={'sa-b1-metrics-panel-b1-wordcount'}>{snapshot.wordCount} <span>woorden</span></div>
        </div>

        <div class={'sa-b1-metrics-panel-b1-toolbar'}>
            <button
                type="button"
                class="{'sa-b1-metrics-panel-b1-help-toggle'} {helpOpen ? 'sa-b1-metrics-panel-b1-help-toggle--open' : ''}"
                on:click={() => (helpOpen = !helpOpen)}
            >
                <i class="ph-bold ph-info"></i>
                {helpOpen ? 'Verberg uitleg & bronnen' : 'Uitleg & bronnen'}
            </button>
            {#if docUrl}
                <a class={'sa-b1-metrics-panel-b1-doc-link'} href={docUrl} target="_blank" rel="noopener noreferrer">
                    Online richtlijnen (documentatie)
                </a>
            {/if}
        </div>

        {#if helpOpen}
            <div class={'sa-b1-metrics-panel-b1-help-drawer'}>
                {#if docUrl}
                    <p class={'sa-b1-metrics-panel-b1-help-doc-callout'}>
                        <strong>Algemene documentatie:</strong>
                        <a href={docUrl} target="_blank" rel="noopener noreferrer">{docUrl}</a>
                        <span class={'sa-b1-metrics-panel-b1-help-doc-hint'}> (aparte bronnen per parameter kunnen in Beheer worden toegevoegd)</span>
                    </p>
                {/if}
                <p class={'sa-b1-metrics-panel-b1-help-intro'}>{guidelines.sourceNote}</p>
                {#if guidelines.globalSources?.length}
                    <p class={'sa-b1-metrics-panel-b1-help-sub'}>Algemene bronnen (configuratie)</p>
                    <ul class={'sa-b1-metrics-panel-b1-source-list'}>
                        {#each guidelines.globalSources as s}
                            <li>
                                {#if safeLinkUrl(s.url)}
                                    <a href={safeLinkUrl(s.url)} target="_blank" rel="noopener noreferrer">{s.label}</a>
                                {:else}
                                    {s.label}
                                {/if}
                                {#if s.note}<span class={'sa-b1-metrics-panel-b1-src-note'}> — {s.note}</span>{/if}
                            </li>
                        {/each}
                    </ul>
                {/if}
                {#each helpKeys as key}
                    {@const def = guidelines.metrics[key]}
                    <div class={'sa-b1-metrics-panel-b1-help-metric'}>
                        <div class={'sa-b1-metrics-panel-b1-help-metric-title'}>{def.label}</div>
                        <div class={'sa-b1-metrics-panel-b1-help-metric-body'}>{def.howComputed}</div>
                        <div class={'sa-b1-metrics-panel-b1-help-band'}><strong>Banden:</strong> {formatB1MetricBands(def)}</div>
                        {#if def.sources?.length}
                            <ul class="{'sa-b1-metrics-panel-b1-source-list'} {'sa-b1-metrics-panel-b1-source-list--compact'}">
                                {#each def.sources as s}
                                    <li>
                                        {#if safeLinkUrl(s.url)}
                                            <a href={safeLinkUrl(s.url)} target="_blank" rel="noopener noreferrer">{s.label}</a>
                                        {:else}
                                            {s.label}
                                        {/if}
                                        {#if s.note}<span class={'sa-b1-metrics-panel-b1-src-note'}> — {s.note}</span>{/if}
                                    </li>
                                {/each}
                            </ul>
                        {:else}
                            <p class={'sa-b1-metrics-panel-b1-no-src'}>
                                Geen org-specifieke bron voor deze parameter in de configuratie.
                                {#if docUrl}
                                    Zie de <a href={docUrl} target="_blank" rel="noopener noreferrer">algemene B1-metriekpagina</a> of voeg bronnen toe onder Beheer → <code>b1Guidelines</code>.
                                {:else}
                                    Voeg bronnen toe onder Beheer (<code>b1Guidelines</code>) en/of zet <code>PUBLIC_B1_METRICS_DOC_URL</code> in de root-<code>.env</code> voor een vaste documentatielink.
                                {/if}
                            </p>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}

        {#if overallScore != null}
            <div class={'sa-b1-metrics-panel-b1-score-bar-wrap'}>
                <div class={'sa-b1-metrics-panel-b1-score-labels'}>
                    <span class={'sa-b1-metrics-panel-b1-score-label'} style="color: {scoreColor}">{scoreLabel}</span>
                    <span class={'sa-b1-metrics-panel-b1-score-pct'} style="color: {scoreColor}">{overallScore}%</span>
                </div>
                <div class={'sa-b1-metrics-panel-b1-score-track'}>
                    <div class={'sa-b1-metrics-panel-b1-score-fill'} style="width: {overallScore}%; background: {scoreColor}"></div>
                    <div class={'sa-b1-metrics-panel-b1-score-line'} style="left: 55%"></div>
                    <div class={'sa-b1-metrics-panel-b1-score-line'} style="left: 80%"></div>
                </div>
                <div class={'sa-b1-metrics-panel-b1-score-zones'}>
                    <span>Verbetering nodig</span>
                    <span style="margin-left: calc(55% - 48px)">Redelijk</span>
                    <span style="margin-left: calc(25% - 20px)">Goed</span>
                </div>
            </div>
        {/if}

        <p class={'sa-b1-metrics-panel-b1-metrics-disclaimer'}>
            Indicatieve proxies in de editor: geen officiële taaltoets. Drempels en verwijzingen kunnen per organisatie worden
            ingesteld; de totaalscore weegt meerdere parameters.
        </p>

        <div class={'sa-b1-metrics-panel-b1-chip-grid'}>
            {#each chipRows as { key, val, status, def }}
                {@const suffix = formatSuffix(key)}
                <div
                    class={'sa-b1-metrics-panel-b1-chip'}
                    style="border-left: 3px solid {STATUS_COLOR[status]}; background: {STATUS_BG[status]}"
                    title={def.hint}
                >
                    <span class={'sa-b1-metrics-panel-chip-label'}>{def.label}</span>
                    <span class={'sa-b1-metrics-panel-chip-value'} style="color: {STATUS_COLOR[status]}">{formatChipValue(key, val)}{suffix}</span>
                    <div class={'sa-b1-metrics-panel-chip-meta-rows'}>
                        <div class={'sa-b1-metrics-panel-chip-meta'}>
                            <span class={'sa-b1-metrics-panel-chip-target'}>doel: {def.target}</span>
                            <span class={'sa-b1-metrics-panel-chip-status'} style="color: {STATUS_COLOR[status]}">{STATUS_LABEL[status]}</span>
                        </div>
                        <div class={'sa-b1-metrics-panel-chip-band'}>{formatB1MetricBands(def)}</div>
                    </div>
                </div>
            {/each}

            {#if !(visibleMetricKeys != null && visibleMetricKeys.length)}
            <div class="{'sa-b1-metrics-panel-b1-chip'} {'sa-b1-metrics-panel-b1-chip--info'}" title="Aantal getelde zinnen in het hoofdstuk">
                <span class={'sa-b1-metrics-panel-chip-label'}>Zinnen geteld</span>
                <span class={'sa-b1-metrics-panel-chip-value'}>{snapshot.sentenceCount || 0}</span>
                <div class={'sa-b1-metrics-panel-chip-meta'}>
                    <span class={'sa-b1-metrics-panel-chip-target'}>indicatief</span>
                </div>
            </div>
            <div class="{'sa-b1-metrics-panel-b1-chip'} {'sa-b1-metrics-panel-b1-chip--info'}" title="Aantal alinea's (schatting)">
                <span class={'sa-b1-metrics-panel-chip-label'}>Alinea's (schatting)</span>
                <span class={'sa-b1-metrics-panel-chip-value'}>{snapshot.paragraphCount}</span>
                <div class={'sa-b1-metrics-panel-chip-meta'}>
                    <span class={'sa-b1-metrics-panel-chip-target'}>indicatief</span>
                </div>
            </div>
            {/if}
        </div>
    </div>
{/if}
