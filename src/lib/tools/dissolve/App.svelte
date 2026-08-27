<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { detectColumns, type ColumnGuess } from "$lib/db/columns";
  import { PipelineError, runDissolve, type DissolveIssueRow } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Dissolving", "Checking for gaps"];

  let files = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let columns = $state<ColumnGuess | null>(null);
  let groupBy = $state<Set<string>>(new Set());

  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-2=active stage, 3=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let keptColumns = $state<string[]>([]);
  let droppedColumns = $state<string[]>([]);
  let issues = $state<DissolveIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  // Fits the map to the loaded input while the user picks group-by columns;
  // the dissolved result replaces resultBounds once the run completes.
  async function computeLoadedBounds(
    conn: NonNullable<typeof duckdbState.conn>,
  ): Promise<[number, number, number, number] | null> {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM layer_01 WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))
      ? [xmin, ymin, xmax, ymax]
      : null;
  }

  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (!loading) handleLoad();
    });
  });

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    columns = null;
    groupBy = new Set();
    resetResults();

    try {
      await loadFile(duckdbState.db!, duckdbState.conn!, files);
      columns = await detectColumns(duckdbState.conn!, "layer_attr");
      resultBounds = await computeLoadedBounds(duckdbState.conn!);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function resetResults(): void {
    resultGeoJSON = null;
    resultBounds = null;
    keptColumns = [];
    droppedColumns = [];
    issues = [];
    issuesGeoJSON = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
  }

  function toggleGroupBy(col: string): void {
    const next = new Set(groupBy);
    if (next.has(col)) next.delete(col);
    else next.add(col);
    groupBy = next;
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resultGeoJSON = null;
    resultBounds = null;
    keptColumns = [];
    droppedColumns = [];
    issues = [];
    issuesGeoJSON = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      const result = await runDissolve(duckdbState.conn!, Array.from(groupBy), (stage, label) => {
        currentStage = stage;
        stageLabel = label;
      });
      resultGeoJSON = result.dissolvedGeoJSON;
      resultBounds = result.bounds;
      keptColumns = result.keptColumns;
      droppedColumns = result.droppedColumns;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      currentStage = 3;
      stageLabel = "Done";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 3) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Dissolve</h1>
      <p class="blurb">
        Aggregate a fine polygon layer into a coarser one by grouping on one or more attribute
        columns, unioning each group's geometry into a single feature.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <DropZone
        bind:files
        disabled={loading || running}
        helpText="Polygon layer in WGS84. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if columns}
      <section class="step">
        <h2 class="step-heading">Group by</h2>
        <fieldset class="col-list">
          {#each columns.all as col (col)}
            <label class="col-item">
              <input
                type="checkbox"
                checked={groupBy.has(col)}
                disabled={running}
                onchange={() => toggleGroupBy(col)}
              />
              <span>{col}</span>
            </label>
          {/each}
        </fieldset>
        <button class="run-btn" onclick={handleRun} disabled={running || groupBy.size === 0}>
          {running ? "Dissolving…" : "Run"}
        </button>
      </section>
    {/if}

    {#if running || errorStage > 0}
      <ol class="stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}
              <span class="stage-x">✕</span>
            {:else}
              <span class="stage-dot"></span>
            {/if}
            <span class="stage-label"
              >{i + 1 === currentStage && stageLabel ? stageLabel : label}</span
            >
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if resultGeoJSON}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        {#if droppedColumns.length > 0}
          <p class="summary-line">
            Dropped {droppedColumns.length} column{droppedColumns.length === 1 ? "" : "s"} not
            constant within every group: {droppedColumns.join(", ")}.
          </p>
        {/if}
        {#if keptColumns.length > 0}
          <p class="summary-line">Kept: {keptColumns.join(", ")}.</p>
        {/if}
        <p class="summary-line">
          {issues.length} gap{issues.length === 1 ? "" : "s"} wider than the noise floor
          {issues.length === 1 ? "remains" : "remain"} in the output.
        </p>
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="dissolve"
        />
        {#if issues.length > 0}
          <DownloadMenu
            primaryLabel="Download Issues"
            filenameStem={fileStem(files[0])}
            cachedGeoJSON={issuesGeoJSON ?? undefined}
            exportSource="dissolve_issues"
            variant="secondary"
          />
        {/if}
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON}
      bounds={resultBounds}
      processing={loading || running}
      registerClear={(fn: () => void) => { clearMap = fn; }}
    />
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: 100dvh;
    overflow: hidden;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid #e5e7eb;
    background: #fff;
  }

  header h1 {
    font-size: 1.25rem;
    font-weight: 700;
    color: #111;
    margin: 0 0 0.5rem;
  }

  .back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin: 0 0 0.5rem;
  }

  .back:hover {
    color: #111;
  }

  .blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }

  .status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .col-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    margin: 0;
  }

  .col-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.825rem;
    color: #374151;
  }

  .run-btn {
    background: #1d4ed8;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .run-btn:hover:not(:disabled) {
    background: #1e40af;
  }

  .run-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stages li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #9ca3af;
  }

  .stages li.done {
    color: #16a34a;
  }

  .stages li.active {
    color: #1d4ed8;
    font-weight: 500;
    animation: pulse 1s ease-in-out infinite;
  }

  .stages li.error {
    color: #dc2626;
    font-weight: 500;
  }

  .stage-x {
    width: 8px;
    font-size: 0.75rem;
    line-height: 1;
    flex-shrink: 0;
    text-align: center;
  }

  .stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  .error-panel {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: #b91c1c;
    word-break: break-word;
  }

  .summary-line {
    font-size: 0.8rem;
    color: #6b7280;
    line-height: 1.4;
    margin: 0;
  }

  .privacy {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0;
    margin-top: auto;
  }

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
