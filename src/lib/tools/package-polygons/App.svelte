<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import type { ExportSource } from "$lib/db/export";
  import {
    runPackagePolygons,
    type PackagePolygonsLevelResult,
    type TargetSchema,
  } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
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
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let levels = $state<PackagePolygonsLevelResult[]>([]);
  let selectedIndex = $state(0);

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
    levels = [];
    selectedIndex = 0;
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
    levels = [];
    selectedIndex = 0;

    const schema: TargetSchema | null =
      nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
    try {
      const result = await runPackagePolygons(duckdbState.conn!, schema);
      levels = result.levels;
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
  const selected = $derived(levels[selectedIndex] as PackagePolygonsLevelResult | undefined);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Package Polygons</h1>
      <p class="blurb">
        Dissolve a polygon layer up to every coarser admin level it contains, one output file per
        level. The finest level needs no dissolve, so it isn't offered as a separate download.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layer" collapsed={ran} detail={files[0]?.name ?? ""}>
      <DropZone
        bind:files
        urlParam="url"
        disabled={loading || running}
        helpText="Polygon layer. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </InputStep>

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

    {#if ran}
      <section class="step">
        <h2 class="step-heading">Levels</h2>
        <div class="level-list">
          {#each levels as lvl, i (lvl.level)}
            <button
              type="button"
              class="level-btn"
              class:active={i === selectedIndex}
              onclick={() => (selectedIndex = i)}
            >
              Level {lvl.level}{lvl.exportable ? "" : " (finest, source)"}
            </button>
          {/each}
        </div>

        {#if selected}
          {@const gaps = selected.issues.filter((i) => i.kind === "gap").length}
          {@const micro = selected.issues.length - gaps}
          <p class="summary-line">
            {selected.keptColumns.length} kept, {selected.summedColumns.length} summed,
            {selected.droppedColumns.length} dropped.
            {gaps} gap issue{gaps === 1 ? "" : "s"}{micro > 0
              ? `, ${micro} micro-polygon${micro === 1 ? "" : "s"} merged or dropped`
              : ""}.
          </p>
          {#if selected.exportable}
            {@const src = levelExportSource(selected.level)}
            {#if src}
              <DownloadMenu
                primaryLabel="Download level {selected.level}"
                filenameStem={fileStem(files[0])}
                cachedGeoJSON={selected.resultGeoJSON}
                exportSource={src}
              />
            {/if}
          {:else}
            <p class="field-hint">Identical to the source layer; download it directly instead.</p>
          {/if}
        {/if}
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="map-container">
    <MapView
      geojson={selected?.resultGeoJSON}
      originalGeojson={originalGeoJSON}
      bounds={selected?.bounds ?? loadedBounds}
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
    border-right: 1px solid var(--hdx-neutral-1);
    background: var(--hdx-neutral-0);
  }

  header {
    margin: -1.25rem -1.25rem 0;
    padding: 1.25rem 1.25rem 0.8125rem;
    background: var(--hdx-brand-7);
  }
  header + .step {
    border-top: none;
    padding-top: 0;
  }
  header .blurb,
  header .back {
    color: var(--hdx-brand-05);
  }
  header .back:hover {
    color: var(--hdx-neutral-0);
  }
  header h1 {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--hdx-neutral-0);
    margin: 0 0 0.5rem;
  }

  .back {
    display: inline-block;
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    text-decoration: none;
    margin: 0 0 0.5rem;
  }

  .back:hover {
    color: var(--hdx-neutral-9);
  }

  .blurb {
    font-size: 0.825rem;
    color: var(--hdx-neutral-8);
    margin: 0;
    line-height: 1.5;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--hdx-neutral-1);
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
    margin: 0;
  }

  .status {
    font-size: 0.85rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .field-hint {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-8);
  }

  .field input {
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-md);
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--hdx-error-6);
    margin: 0;
  }

  .run-btn {
    background: var(--hdx-primary-5);
    color: var(--hdx-neutral-0);
    border: none;
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .run-btn:hover:not(:disabled) {
    background: var(--hdx-primary-9);
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
    background: var(--hdx-error-05);
    border: 1px solid var(--hdx-error-3);
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--hdx-error-6);
    word-break: break-word;
  }

  .level-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .level-btn {
    background: var(--hdx-neutral-0);
    color: var(--hdx-neutral-8);
    border: 1px solid var(--hdx-neutral-2);
    border-radius: 999px;
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .level-btn:hover {
    background: var(--hdx-neutral-05);
  }

  .level-btn.active {
    background: var(--hdx-primary-5);
    color: var(--hdx-neutral-0);
    border-color: var(--hdx-primary-5);
  }

  .summary-line {
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
    line-height: 1.4;
    margin: 0;
  }

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
