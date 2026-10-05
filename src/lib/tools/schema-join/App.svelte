<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { boolParam, numberParam, textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { attributesAt, type Bounds } from "$lib/db/layerView";
  import {
    DEFAULT_TARGET_SCHEMA,
    MIN_OVERLAP_DEFAULT,
    joinedRow,
    loadAndAssign,
    runSchemaJoin,
    type JoinIssueRow,
    type SchemaJoinResult,
  } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import JoinTable from "./JoinTable.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let inputFiles = $state<File[]>([]);
  let joinFiles = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let inputGeoJSON = $state<string | null>(null);
  let joinGeoJSON = $state<string | null>(null);
  let viewBounds = $state<Bounds | null>(null);
  let inputCount = $state(0);

  let useTemplates = $state(false);
  let nameField = $state(DEFAULT_TARGET_SCHEMA.nameField);
  let codeField = $state(DEFAULT_TARGET_SCHEMA.codeField);
  let minOverlap = $state(MIN_OVERLAP_DEFAULT);
  syncParam("templates", boolParam, () => useTemplates, (v) => (useTemplates = v));
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));
  syncParam("overlap", numberParam, () => minOverlap, (v) => (minOverlap = v));
  let settingsOpen = $state(false);

  let running = $state(false);
  let error = $state<string | null>(null);
  let result = $state.raw<SchemaJoinResult | null>(null);
  let selectedValues = $state<Record<string, string | null> | null>(null);
  let selectedKey = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  // DuckDB work runs one task at a time, in order.
  let queue: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task);
  }

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  $effect(() => {
    const c = inputFiles;
    const p = joinFiles;
    if (c.length === 0 || p.length === 0 || !duckdbState.ready) return;
    untrack(() => enqueue(handleLoad));
  });

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    inputGeoJSON = null;
    joinGeoJSON = null;
    viewBounds = null;
    result = null;
    error = null;
    selectedValues = null;
    selectedKey = null;
    try {
      const layers = await loadAndAssign(
        duckdbState.db!,
        duckdbState.conn!,
        inputFiles,
        joinFiles,
      );
      inputGeoJSON = layers.inputGeoJSON;
      joinGeoJSON = layers.joinGeoJSON;
      viewBounds = layers.bounds;
      inputCount = layers.inputCount;
      loaded = true;
    } catch (e) {
      loadError = message(e);
    } finally {
      loading = false;
    }
  }

  async function join(): Promise<void> {
    running = true;
    selectedValues = null;
    selectedKey = null;
    try {
      result = await runSchemaJoin(
        duckdbState.conn!,
        useTemplates ? { nameField, codeField } : null,
        minOverlap,
      );
      error = null;
    } catch (e) {
      result = null;
      error = message(e);
    } finally {
      running = false;
    }
  }

  $effect(() => {
    void [useTemplates, nameField, codeField, minOverlap];
    if (!loaded || !settingsValid) return;
    const timer = setTimeout(() => untrack(() => enqueue(join)), 400);
    return () => clearTimeout(timer);
  });

  async function inspectAt(lngLat: [number, number] | null): Promise<void> {
    selectedKey = null;
    selectedValues =
      lngLat && result
        ? await attributesAt(duckdbState.conn!, lngLat, "input_layer_01", "sj_result_attr")
        : null;
  }

  async function showIssue(issue: JoinIssueRow): Promise<void> {
    selectedKey = issue.key;
    viewBounds = issue.bbox;
    selectedValues = await joinedRow(duckdbState.conn!, issue.unitA);
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const templateValid = $derived(nameField.includes("{n}") && codeField.includes("{n}"));
  const overlapValid = $derived(minOverlap > 0 && minOverlap <= 1);
  const settingsValid = $derived(overlapValid && (!useTemplates || templateValid));

  $effect(() => {
    if (!settingsValid) settingsOpen = true;
  });
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Schema Join</h1>
      <DemoLink slug="schema-join" />
      <p class="blurb">
        Copy a join layer's admin hierarchy columns onto each polygon of the input layer, from the
        join polygon it overlaps most. Geometry is left as is. Where a polygon already has a column
        with different values, the join layer's values are added as a numbered sibling column.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <h2 class="step-heading">Input layer</h2>
      <DropZone
        bind:files={inputFiles}
        urlParam="input"
        disabled={loading}
        helpText="The layer to add columns to, e.g. admin 2."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Join layer</h2>
      <DropZone
        bind:files={joinFiles}
        urlParam="join"
        disabled={loading}
        helpText="The coarser layer whose hierarchy columns to copy, e.g. admin 1."
      />
      {#if loading}<p class="status">Loading and matching…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if loaded}
      <details class="step" bind:open={settingsOpen}>
        <summary class="step-heading">
          Settings <span class="optional">(optional)</span>
        </summary>
        <div class="step-body">
          <label class="field">
            <span>Minimum overlap</span>
            <input type="number" min="0.01" max="1" step="0.05" bind:value={minOverlap} />
          </label>
          <p class="field-hint">
            Flag a polygon when its best join polygon covers less than this share of its area.
          </p>
          {#if !overlapValid}
            <p class="field-error">Minimum overlap must be above 0 and at most 1.</p>
          {/if}
          <label class="toggle">
            <input type="checkbox" bind:checked={useTemplates} />
            <span>Use naming templates</span>
          </label>
          <p class="field-hint">
            Pick the join layer's hierarchy columns by name instead of detecting them from the values.
          </p>
          {#if useTemplates}
            <label class="field">
              <span>Name template</span>
              <input type="text" class="mono" bind:value={nameField} />
            </label>
            <label class="field">
              <span>Code template</span>
              <input type="text" class="mono" bind:value={codeField} />
            </label>
            {#if !templateValid}
              <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
            {/if}
          {/if}
        </div>
      </details>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download Joined Layer"
          filenameStem={fileStem(inputFiles[0])}
          exportSource="schema_join"
        />
        {#if result.issues.length > 0}
          <DownloadMenu
            primaryLabel="Download Issues"
            filenameStem={fileStem(inputFiles[0])}
            exportSource="schema_join_issues"
            variant="secondary"
          />
        {/if}
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <MapTableSplit>
    {#snippet map()}
      <MapView
        originalGeojson={inputGeoJSON}
        overlayOutlineGeojson={joinGeoJSON}
        bounds={viewBounds}
        processing={loading || running}
        onFeatureClick={inspectAt}
        registerClear={(fn: () => void) => {
          clearMap = fn;
        }}
      />
    {/snippet}
    {#snippet table()}
      <JoinTable
        {result}
        {inputCount}
        values={selectedValues}
        {selectedKey}
        emptyText={!loaded
          ? "Load an input and a join layer to join them."
          : running
            ? "Joining…"
            : "Fix the settings to run the join."}
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
  }

  .field input.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  summary.step-heading {
    cursor: pointer;
    user-select: none;
  }

  .step-body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .optional {
    font-weight: 400;
    color: var(--hdx-neutral-7);
    font-size: 0.85rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--hdx-neutral-9);
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--hdx-error-6);
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
