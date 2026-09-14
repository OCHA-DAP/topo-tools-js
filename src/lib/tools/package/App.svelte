<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import type { ExportSource } from "$lib/db/export";
  import { runPackage, type PackageResult, type TargetSchema } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let files = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let nameField = $state("");
  let codeField = $state("");

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let result = $state<PackageResult | null>(null);

  type View = { kind: "polygons"; levelIndex: number } | { kind: "points" } | { kind: "lines" };
  let view = $state<View>({ kind: "polygons", levelIndex: 0 });

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

  function resetRun(): void {
    ran = false;
    error = null;
    result = null;
    view = { kind: "polygons", levelIndex: 0 };
  }

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    resetRun();

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

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    result = null;

    const schema: TargetSchema | null =
      nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
    try {
      result = await runPackage(duckdbState.conn!, schema);
      view = { kind: "polygons", levelIndex: 0 };
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

  function levelExportSource(level: number): ExportSource | null {
    if (level < 0 || level > 7) return null;
    return `package_polygons_level_${level}` as ExportSource;
  }

  const bothBlank = $derived(nameField.trim() === "" && codeField.trim() === "");
  const oneBlank = $derived((nameField.trim() === "") !== (codeField.trim() === ""));
  const templateValid = $derived(
    !oneBlank && (bothBlank || (nameField.includes("{n}") && codeField.includes("{n}"))),
  );

  const selectedPolygonLevel = $derived(
    result && view.kind === "polygons" ? result.polygons.levels[view.levelIndex] : undefined,
  );
  const activeGeoJSON = $derived(
    !result
      ? null
      : view.kind === "polygons"
        ? (selectedPolygonLevel?.resultGeoJSON ?? null)
        : view.kind === "points"
          ? result.points.resultGeoJSON
          : result.lines.resultGeoJSON,
  );
  const activeBounds = $derived(
    !result
      ? null
      : view.kind === "polygons"
        ? (selectedPolygonLevel?.bounds ?? null)
        : view.kind === "points"
          ? result.points.bounds
          : result.lines.bounds,
  );
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Package</h1>
      <p class="blurb">
        Run Package Polygons, Package Points, and Package Lines against the same layer in one
        pass, and browse all three outputs.
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
        bind:files
        disabled={loading || running}
        helpText="Polygon layer. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if loaded}
      <section class="step">
        <h2 class="step-heading">Target schema</h2>
        <p class="field-hint">
          Naming templates for a resolved level's number. Leave both blank to auto-detect the
          hierarchy structurally instead.
        </p>
        <label class="field">
          <span>Name template</span>
          <input type="text" bind:value={nameField} placeholder="auto-detect" disabled={running} />
        </label>
        <label class="field">
          <span>Code template</span>
          <input type="text" bind:value={codeField} placeholder="auto-detect" disabled={running} />
        </label>
        {#if oneBlank}
          <p class="field-error">Both templates must be set, or both left blank to auto-detect.</p>
        {:else if !bothBlank && !templateValid}
          <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
        {/if}
        <button class="run-btn" onclick={handleRun} disabled={running || !templateValid}>
          {running ? "Packaging…" : "Run"}
        </button>
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if ran && result}
      <section class="step">
        <h2 class="step-heading">Polygons</h2>
        <div class="level-list">
          {#each result.polygons.levels as lvl, i (lvl.level)}
            <button
              type="button"
              class="level-btn"
              class:active={view.kind === "polygons" && view.levelIndex === i}
              onclick={() => (view = { kind: "polygons", levelIndex: i })}
            >
              Level {lvl.level}{lvl.exportable ? "" : " (finest)"}
            </button>
          {/each}
        </div>
        {#if selectedPolygonLevel}
          <p class="summary-line">
            {selectedPolygonLevel.keptColumns.length} kept, {selectedPolygonLevel.summedColumns
              .length} summed, {selectedPolygonLevel.droppedColumns.length} dropped.
            {selectedPolygonLevel.issues.length} gap issue{selectedPolygonLevel.issues.length === 1
              ? ""
              : "s"}.
          </p>
          {#if selectedPolygonLevel.exportable}
            {@const src = levelExportSource(selectedPolygonLevel.level)}
            {#if src}
              <DownloadMenu
                primaryLabel="Download level {selectedPolygonLevel.level}"
                filenameStem={fileStem(files[0])}
                cachedGeoJSON={selectedPolygonLevel.resultGeoJSON}
                exportSource={src}
              />
            {/if}
          {:else}
            <p class="field-hint">Identical to the source layer; download it directly instead.</p>
          {/if}
        {/if}
      </section>

      <section class="step">
        <h2 class="step-heading">Points</h2>
        <button type="button" class="level-btn" class:active={view.kind === "points"} onclick={() => (view = { kind: "points" })}>
          Combined ({result.points.levels.join(", ")})
        </button>
        <DownloadMenu
          primaryLabel="Download points"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={result.points.resultGeoJSON}
          exportSource="package_points"
        />
      </section>

      <section class="step">
        <h2 class="step-heading">Lines</h2>
        <button type="button" class="level-btn" class:active={view.kind === "lines"} onclick={() => (view = { kind: "lines" })}>
          Combined ({result.lines.levels.join(", ")})
        </button>
        <DownloadMenu
          primaryLabel="Download lines"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={result.lines.resultGeoJSON}
          exportSource="package_lines"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={activeGeoJSON ?? originalGeoJSON}
      originalGeojson={activeGeoJSON ? originalGeoJSON : null}
      bounds={activeBounds ?? loadedBounds}
      processing={loading || running}
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

  .level-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .level-btn {
    background: #fff;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .level-btn:hover {
    background: #f3f4f6;
  }

  .level-btn.active {
    background: #1d4ed8;
    color: #fff;
    border-color: #1d4ed8;
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
