<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import {
    runSchemaRefactor,
    loadCrosswalkCsv,
    parseCrosswalk,
    type CrosswalkRow,
  } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let layerFiles = $state<File[]>([]);
  let crosswalkFiles = $state<File[]>([]);

  let layerLoading = $state(false);
  let layerLoaded = $state(false);
  let layerLoadError = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let crosswalkLoading = $state(false);
  let crosswalk = $state<CrosswalkRow[] | null>(null);
  let crosswalkLoadError = $state<string | null>(null);

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let renamedCount = $state(0);
  let droppedColumns = $state<string[]>([]);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  async function computeLoadedBounds(): Promise<[number, number, number, number] | null> {
    const conn = duckdbState.conn!;
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
    const f = layerFiles;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (!layerLoading) handleLoadLayer();
    });
  });

  $effect(() => {
    const f = crosswalkFiles;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (!crosswalkLoading) handleLoadCrosswalk();
    });
  });

  function resetRun(): void {
    ran = false;
    error = null;
    resultGeoJSON = null;
    resultBounds = null;
    renamedCount = 0;
    droppedColumns = [];
  }

  async function handleLoadLayer(): Promise<void> {
    clearMap?.();
    layerLoadError = null;
    layerLoading = true;
    layerLoaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    resetRun();

    try {
      await loadFile(duckdbState.db!, duckdbState.conn!, layerFiles);
      originalGeoJSON = await tableToGeoJSON(duckdbState.conn!, "layer_01", null);
      loadedBounds = await computeLoadedBounds();
      layerLoaded = true;
    } catch (e) {
      layerLoadError = e instanceof Error ? e.message : String(e);
    } finally {
      layerLoading = false;
    }
  }

  async function handleLoadCrosswalk(): Promise<void> {
    crosswalkLoadError = null;
    crosswalkLoading = true;
    crosswalk = null;
    resetRun();

    try {
      await loadCrosswalkCsv(duckdbState.db!, duckdbState.conn!, crosswalkFiles);
      crosswalk = await parseCrosswalk(duckdbState.conn!);
    } catch (e) {
      crosswalkLoadError = e instanceof Error ? e.message : String(e);
    } finally {
      crosswalkLoading = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resultGeoJSON = null;
    resultBounds = null;
    renamedCount = 0;
    droppedColumns = [];

    try {
      const result = await runSchemaRefactor(duckdbState.conn!, crosswalk!);
      resultGeoJSON = result.resultGeoJSON;
      resultBounds = result.bounds;
      renamedCount = result.renamedCount;
      droppedColumns = result.droppedColumns;
      ran = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const canRun = $derived(layerLoaded && crosswalk !== null && !layerLoading && !crosswalkLoading);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Schema Refactor</h1>
      <p class="blurb">
        Apply a crosswalk CSV, from Schema Map or hand-edited, to rename or drop a polygon layer's
        columns. No topology check, no geometry mutation, geometry passes through completely
        unchanged.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <h2 class="step-heading">Layer</h2>
      <DropZone
        bind:files={layerFiles}
        disabled={layerLoading || running}
        helpText="Polygon layer. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if layerLoading}<p class="status">Loading layer...</p>{/if}
      {#if layerLoadError}<div class="error-panel">{layerLoadError}</div>{/if}
    </section>

    <section class="step">
      <h2 class="step-heading">Crosswalk CSV</h2>
      <DropZone
        bind:files={crosswalkFiles}
        disabled={crosswalkLoading || running}
        accept="csv"
        helpText="source_column, target_column, from Schema Map or hand-edited."
      />
      {#if crosswalkLoading}<p class="status">Loading crosswalk...</p>{/if}
      {#if crosswalkLoadError}<div class="error-panel">{crosswalkLoadError}</div>{/if}
    </section>

    {#if layerLoaded && crosswalk !== null}
      <section class="step">
        <button class="run-btn" onclick={handleRun} disabled={!canRun || running}>
          {running ? "Renaming..." : "Run"}
        </button>
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if ran}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        <p class="summary-line">{renamedCount} column{renamedCount === 1 ? "" : "s"} renamed.</p>
        {#if droppedColumns.length > 0}
          <p class="summary-line">
            {droppedColumns.length} column{droppedColumns.length === 1 ? "" : "s"} dropped:
            {droppedColumns.join(", ")}.
          </p>
        {/if}
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(layerFiles[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="schema_refactor"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON ?? originalGeoJSON}
      originalGeojson={resultGeoJSON ? originalGeoJSON : null}
      bounds={resultBounds ?? loadedBounds}
      processing={layerLoading || crosswalkLoading || running}
      registerClear={(fn: () => void) => {
        clearMap = fn;
      }}
    />
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 340px 1fr;
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
    gap: 0.6rem;
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
