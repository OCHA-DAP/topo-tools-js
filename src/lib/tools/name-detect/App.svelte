<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import { runNameDetect, type NameResult, type NameIssueRow, type TargetSchema } from "./pipeline/index";
  import { runNameClean } from "$lib/tools/name-clean/pipeline/index";
  import { onMount, untrack } from "svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import NameTable from "./NameTable.svelte";

  // Name Clean is Name Detect plus the safe fixes, so both pages share this app.
  let { clean = false }: { clean?: boolean } = $props();

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
  let result = $state<NameResult | null>(null);
  let selectedKey = $state<string | null>(null);

  onMount(() => {
    initDuckDB();
  });

  async function computeLoadedBounds(): Promise<[number, number, number, number] | null> {
    const r = await duckdbState.conn!.query(`--sql
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
    loadError = null;
    loading = true;
    loaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    result = null;
    error = null;
    selectedKey = null;
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
    if (loaded && templateValid) await handleRun();
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    result = null;
    selectedKey = null;
    const schema: TargetSchema | null = bothBlank ? null : { nameField, codeField };
    try {
      result = await (clean ? runNameClean : runNameDetect)(duckdbState.conn!, schema);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function showIssue(issue: NameIssueRow): void {
    selectedKey = selectedKey === issue.key ? null : issue.key;
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const bothBlank = $derived(nameField.trim() === "" && codeField.trim() === "");
  const oneBlank = $derived((nameField.trim() === "") !== (codeField.trim() === ""));
  const templateValid = $derived(
    !oneBlank && (bothBlank || (nameField.includes("{n}") && codeField.includes("{n}"))),
  );
  const canRun = $derived(loaded && templateValid && !loading);
  const viewBounds = $derived(
    (selectedKey && result?.rowBounds.get(selectedKey)) || loadedBounds,
  );
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>{clean ? "Name Clean" : "Name Detect"}</h1>
      <DemoLink slug={clean ? "name-clean" : "name-detect"} />
      <p class="blurb">
        {#if clean}
          Check a coded layer's unit names and fix only what can't change a name's meaning:
          spacing, invisible characters, Unicode normalization and certain encoding repairs. Case,
          spelling and duplicates are left for review.
        {:else}
          Check a coded layer's unit names for blanks, placeholders, duplicates under one parent,
          encoding errors, invisible characters and case outliers, without changing anything.
        {/if}
        Click any finding to zoom to it.
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
        urlParam="url"
        disabled={loading || running}
        helpText="Coded polygon layer, hierarchy embedded as columns. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if loaded}
      <section class="step">
        <h2 class="step-heading">Target schema</h2>
        <p class="field-hint">
          Naming templates for a level's number. Leave both blank to auto-detect the hierarchy
          structurally instead.
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
        <button class="run-btn" onclick={handleRun} disabled={!canRun || running}>
          {running ? "Checking…" : "Run"}
        </button>
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result}
      <section class="step">
        <h2 class="step-heading">Download</h2>
        {#if clean}
          <DownloadMenu
            primaryLabel="Download GeoJSON"
            filenameStem={fileStem(files[0])}
            exportSource="name_clean"
          />
        {/if}
        <DownloadMenu
          primaryLabel="Download Issues CSV"
          filenameStem={fileStem(files[0])}
          exportSource={clean ? "name_clean_issues" : "name_detect_issues"}
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <MapTableSplit>
    {#snippet map()}
      <MapView
        geojson={result?.flaggedGeoJSON ?? null}
        originalGeojson={originalGeoJSON}
        bounds={viewBounds}
        processing={loading || running}
      />
    {/snippet}
    {#snippet table()}
      <NameTable
        issues={result?.issues ?? null}
        failed={result?.failed ?? []}
        {clean}
        {selectedKey}
        emptyText={!loaded ? "Load a coded layer to check its names." : running ? "Checking…" : "Fix the settings to run the checks."}
        onIssueClick={showIssue}
      />
    {/snippet}
  </MapTableSplit>
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
    text-decoration: none;
    margin: 0 0 0.5rem;
  }

  .blurb {
    font-size: 0.825rem;
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

  .privacy {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    margin-top: auto;
  }
</style>
