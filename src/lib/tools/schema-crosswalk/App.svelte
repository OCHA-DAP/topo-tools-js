<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import {
    runSchemaCrosswalk,
    DEFAULT_TARGET_SCHEMA,
    type CrosswalkRow,
    type TargetSchema,
  } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import ResultsTable from "$lib/tools/schema-map/ResultsTable.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let files = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let nameField = $state(DEFAULT_TARGET_SCHEMA.nameField);
  let codeField = $state(DEFAULT_TARGET_SCHEMA.codeField);

  let running = $state(false);
  let error = $state<string | null>(null);
  let rows = $state<CrosswalkRow[]>([]);
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let renamedCount = $state(0);
  let droppedColumns = $state<string[]>([]);
  let selectedValues = $state<Record<string, string | null> | null>(null);

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
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (!loading) handleLoad();
    });
  });

  function resetResults(): void {
    rows = [];
    ran = false;
    error = null;
    resultGeoJSON = null;
    resultBounds = null;
    renamedCount = 0;
    droppedColumns = [];
    selectedValues = null;
  }

  async function inspectAt(lngLat: [number, number] | null): Promise<void> {
    if (!lngLat) {
      selectedValues = null;
      return;
    }
    const r = await duckdbState.conn!.query(`--sql
      SELECT a.* EXCLUDE (fid) FROM layer_01 g JOIN layer_attr a USING (fid)
      WHERE ST_Intersects(g.geom, ST_Point(${lngLat[0]}, ${lngLat[1]}))
      ORDER BY fid LIMIT 1
    `);
    const row = r.toArray()[0]?.toJSON() as Record<string, unknown> | undefined;
    selectedValues = row
      ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? null : String(v)]))
      : null;
  }

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    resetResults();

    try {
      await loadFile(duckdbState.db!, duckdbState.conn!, files);
      originalGeoJSON = await tableToGeoJSON(duckdbState.conn!, "layer_01", null);
      loadedBounds = await computeLoadedBounds();
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // A template edit during a run queues one rerun with the latest values.
  let rerunQueued = false;

  async function handleRun(): Promise<void> {
    if (running) {
      rerunQueued = true;
      return;
    }
    error = null;
    running = true;

    const schema: TargetSchema = { nameField, codeField };
    try {
      const result = await runSchemaCrosswalk(duckdbState.conn!, schema);
      rows = result.crosswalk;
      resultGeoJSON = result.refactor.resultGeoJSON;
      resultBounds = result.refactor.bounds;
      renamedCount = result.refactor.renamedCount;
      droppedColumns = result.refactor.droppedColumns;
      ran = true;
    } catch (e) {
      resetResults();
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        handleRun();
      }
    }
  }

  $effect(() => {
    // templateValid only flips on validity, so read both templates to reschedule on every edit.
    void [nameField, codeField];
    if (!loaded || !templateValid) return;
    const timer = setTimeout(() => untrack(handleRun), 400);
    return () => clearTimeout(timer);
  });

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const resolvedCount = $derived(rows.filter((r) => r.targetColumn).length);
  const templateValid = $derived(nameField.includes("{n}") && codeField.includes("{n}"));
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Schema Crosswalk</h1>
      <DemoLink slug="schema-crosswalk" />
      <p class="blurb">
        Infer a crosswalk to a target schema, then immediately apply it: one call runs Schema Map
        and Schema Refactor back to back, always mapping fresh.
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
        urlParam="url"
        disabled={loading || running}
        helpText="Polygon layer. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if loaded}
      <section class="step">
        <h2 class="step-heading">Target schema</h2>
        <p class="field-hint">Naming templates for a resolved level's number. Defaults to a generic schema.</p>
        <label class="field">
          <span>Name template</span>
          <input type="text" bind:value={nameField} />
        </label>
        <label class="field">
          <span>Code template</span>
          <input type="text" bind:value={codeField} />
        </label>
        {#if !templateValid}
          <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
        {/if}
        {#if running}<p class="status">Mapping…</p>{/if}
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if ran}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        <p class="summary-line">
          {resolvedCount} of {rows.length} column{rows.length === 1 ? "" : "s"} resolved to a
          target column; {renamedCount} renamed, {droppedColumns.length} dropped.
        </p>
        {#if droppedColumns.length > 0}
          <p class="summary-line">Dropped: {droppedColumns.join(", ")}.</p>
        {/if}
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download Crosswalk CSV"
          filenameStem={fileStem(files[0])}
          exportSource="schema_map"
        />
        <DownloadMenu
          primaryLabel="Download Mapped Layer"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="schema_refactor"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="results-container">
    <div class="map-pane">
      <MapView
        geojson={resultGeoJSON ?? originalGeoJSON}
        originalGeojson={resultGeoJSON ? originalGeoJSON : null}
        bounds={resultBounds ?? loadedBounds}
        processing={loading || running}
        onFeatureClick={inspectAt}
        registerClear={(fn: () => void) => {
          clearMap = fn;
        }}
      />
    </div>
    <div class="table-pane">
      {#if ran}
        <ResultsTable {rows} values={selectedValues ?? {}} />
      {:else}
        <p class="table-empty">Load a layer to see its crosswalk.</p>
      {/if}
    </div>
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

  .field-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .field input {
    padding: 0.4rem 0.55rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .field-error {
    font-size: 0.75rem;
    color: #b91c1c;
    margin: 0;
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

  .results-container {
    display: grid;
    grid-template-rows: 65% 35%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background: #fff;
  }

  .map-pane {
    min-height: 0;
    position: relative;
    border-bottom: 1px solid #e5e7eb;
  }

  .table-pane {
    min-height: 0;
    overflow: hidden;
  }

  .table-empty {
    padding: 1rem;
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
    margin: 0;
  }

  @media (min-width: 1280px) {
    .results-container {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr minmax(26rem, 35%);
    }
    .map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
</style>
