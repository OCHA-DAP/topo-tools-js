<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import { attributesAt, layerBounds, type Bounds } from "$lib/db/layerView";
  import { canonicalOrder } from "$lib/db/adminColumns";
  import {
    applyCrosswalk,
    checkSavedCrosswalk,
    inferCrosswalk,
    loadSavedCrosswalk,
    sampleValues,
    rowIssues,
    DEFAULT_TARGET_SCHEMA,
    type CrosswalkRow,
    type EditableRow,
    type SchemaRefactorResult,
  } from "./pipeline/editor";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import ResultsTable from "./ResultsTable.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let files = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let layerGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<Bounds | null>(null);
  let samples = $state<Record<string, string[]>>({});
  let selectedValues = $state<Record<string, string | null> | null>(null);

  let savedFiles = $state<File[]>([]);
  let savedOpen = $state(false);
  let saved = $state.raw<Map<string, string | null> | null>(null);
  let savedError = $state<string | null>(null);

  $effect(() => {
    if (new URLSearchParams(location.search).has("crosswalk")) savedOpen = true;
  });

  let nameField = $state(DEFAULT_TARGET_SCHEMA.nameField);
  let codeField = $state(DEFAULT_TARGET_SCHEMA.codeField);
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));

  let inferred = $state.raw<CrosswalkRow[]>([]);
  // Templates the current `inferred` came from; applying orders columns by them too.
  let inferredSchema = $state.raw({ ...DEFAULT_TARGET_SCHEMA });
  // Per-source checkbox and text box edits; kept across re-inference.
  let keepEdits = $state.raw<Record<string, boolean>>({});
  let nameEdits = $state.raw<Record<string, string>>({});
  // Source columns in the user's row order; null follows the imported or inferred order.
  let orderEdit = $state.raw<string[] | null>(null);
  let running = $state(false);
  let error = $state<string | null>(null);
  let applied = $state.raw<SchemaRefactorResult | null>(null);

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
    const f = files;
    if (f.length === 0 || !duckdbState.ready) return;
    untrack(() => enqueue(handleLoad));
  });

  $effect(() => {
    const f = savedFiles;
    if (f.length === 0 || !duckdbState.ready) return;
    untrack(() => enqueue(() => handleSavedLoad(f)));
  });

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    layerGeoJSON = null;
    loadedBounds = null;
    samples = {};
    selectedValues = null;
    inferred = [];
    resetAll();
    applied = null;
    error = null;

    try {
      const conn = duckdbState.conn!;
      await loadFile(duckdbState.db!, conn, files);
      layerGeoJSON = await tableToGeoJSON(conn, "layer_01", null);
      loadedBounds = await layerBounds(conn);
      samples = await sampleValues(conn);
      loaded = true;
    } catch (e) {
      loadError = message(e);
    } finally {
      loading = false;
    }
  }

  async function handleSavedLoad(f: File[]): Promise<void> {
    savedError = null;
    try {
      saved = await loadSavedCrosswalk(duckdbState.db!, duckdbState.conn!, f);
      resetAll();
    } catch (e) {
      saved = null;
      savedError = message(e);
    }
  }

  async function infer(): Promise<void> {
    running = true;
    try {
      const schema = { nameField, codeField };
      inferred = await inferCrosswalk(duckdbState.conn!, schema);
      inferredSchema = schema;
      error = null;
    } catch (e) {
      inferred = [];
      applied = null;
      error = message(e);
    } finally {
      running = false;
    }
  }

  async function apply(): Promise<void> {
    const current = rows;
    if (current.length === 0 || rowIssues(current).size > 0) {
      applied = null;
      return;
    }
    try {
      applied = await applyCrosswalk(duckdbState.conn!, current, inferredSchema);
      error = null;
    } catch (e) {
      applied = null;
      error = message(e);
    }
  }

  $effect(() => {
    // templateValid only flips on validity, so read both templates to reschedule on every edit.
    void [nameField, codeField];
    if (!loaded || !templateValid) return;
    const timer = setTimeout(() => untrack(() => enqueue(infer)), 400);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    void rows;
    if (!loaded) return;
    const timer = setTimeout(() => untrack(() => enqueue(apply)), 250);
    return () => clearTimeout(timer);
  });

  async function inspectAt(lngLat: [number, number] | null): Promise<void> {
    selectedValues = lngLat ? await attributesAt(duckdbState.conn!, lngLat) : null;
  }

  function setKeep(source: string, keep: boolean): void {
    keepEdits = { ...keepEdits, [source]: keep };
  }

  function setAllKeep(keep: boolean): void {
    keepEdits = Object.fromEntries(rows.map((r) => [r.sourceColumn, keep]));
  }

  function setName(source: string, name: string): void {
    nameEdits = { ...nameEdits, [source]: name };
  }

  function resetRow(source: string): void {
    const { [source]: _k, ...keepRest } = keepEdits;
    const { [source]: _n, ...nameRest } = nameEdits;
    keepEdits = keepRest;
    nameEdits = nameRest;
  }

  function resetAll(): void {
    keepEdits = {};
    nameEdits = {};
    orderEdit = null;
  }

  function moveRow(source: string, toIndex: number): void {
    const order = rows.map((r) => r.sourceColumn).filter((c) => c !== source);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, source);
    orderEdit = order;
  }

  function sortToDefault(): void {
    orderEdit = defaultOrder;
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const templateValid = $derived(nameField.includes("{n}") && codeField.includes("{n}"));

  const savedMismatch = $derived.by(() => {
    if (!saved || inferred.length === 0) return null;
    try {
      checkSavedCrosswalk(
        saved,
        inferred.map((r) => r.sourceColumn),
      );
      return null;
    } catch (e) {
      return message(e);
    }
  });

  const rows = $derived.by((): EditableRow[] => {
    const useSaved = saved && !savedMismatch ? saved : null;
    const order = orderEdit ?? (useSaved ? [...useSaved.keys()] : null);
    const rank = new Map(order?.map((c, i) => [c, i]));
    const ordered = order
      ? [...inferred].sort(
          (a, b) => (rank.get(a.sourceColumn) ?? Infinity) - (rank.get(b.sourceColumn) ?? Infinity),
        )
      : inferred;
    return ordered.map((r) => {
      const source = r.sourceColumn;
      const baseTarget = useSaved ? (useSaved.get(source) ?? null) : r.targetColumn;
      const keep = keepEdits[source] ?? baseTarget !== null;
      const input = nameEdits[source] ?? baseTarget ?? source;
      const targetColumn = keep ? input.trim() || null : null;
      const edited = keep !== (baseTarget !== null) || input.trim() !== (baseTarget ?? source);
      return { ...r, keep, input, targetColumn, baseTarget, edited };
    });
  });

  // Kept rows in template order of their current targets, then dropped rows as they stand.
  const defaultOrder = $derived.by(() => {
    const kept = rows.filter((r) => r.targetColumn);
    const source = new Map(kept.map((r) => [r.targetColumn!, r.sourceColumn]));
    const { ordered } = canonicalOrder(
      [...source.keys()],
      inferredSchema.nameField,
      inferredSchema.codeField,
    );
    const rest = rows.filter((r) => !r.targetColumn).map((r) => r.sourceColumn);
    return [...ordered.map((t) => source.get(t)!), ...rest];
  });
  const inDefaultOrder = $derived(rows.every((r, i) => r.sourceColumn === defaultOrder[i]));

  const issues = $derived(rowIssues(rows));
  const renamed = $derived(rows.filter((r) => r.targetColumn && r.targetColumn !== r.sourceColumn));
  const kept = $derived(rows.filter((r) => r.targetColumn === r.sourceColumn));
  const dropped = $derived(rows.filter((r) => !r.keep).map((r) => r.sourceColumn));
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Schema Map</h1>
      <DemoLink slug="schema-map" />
      <p class="blurb">
        Infer which columns form the admin hierarchy, from the values alone, and map them to a
        target schema. Tick the columns to keep and edit their targets in the table, then download the renamed layer or the
        crosswalk CSV.
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
        disabled={loading}
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

    <details class="step" bind:open={savedOpen}>
      <summary class="step-heading">
        Import crosswalk <span class="optional">(optional)</span>
      </summary>
      <div class="step-body">
        <p class="field-hint">Start from a crosswalk CSV instead of the inferred one.</p>
        <DropZone
          bind:files={savedFiles}
          urlParam="crosswalk"
          accept="csv"
          helpText="CSV with source_column and target_column."
        />
      </div>
    </details>
    {#if savedError}<div class="error-panel">{savedError}</div>{/if}
    {#if savedMismatch}<div class="error-panel">{savedMismatch}</div>{/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if rows.length > 0}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        {#if issues.size > 0}
          <p class="field-error">
            Fix {issues.size} target{issues.size === 1 ? "" : "s"} in the table to apply the crosswalk.
          </p>
        {:else}
          <p class="summary-line">
            {renamed.length} renamed, {kept.length} kept as is, {dropped.length} dropped.
          </p>
          {#if dropped.length > 0}
            <p class="summary-line">Dropped: {dropped.join(", ")}.</p>
          {/if}
          {#if applied && applied.misorderedSiblings.length > 0}
            <p class="summary-line warn">
              Numbered siblings of {applied.misorderedSiblings.join(", ")} are out of order; output
              columns follow the table order.
            </p>
          {/if}
          {#if applied && !applied.sortColumn}
            <p class="summary-line">
              No target matches the code template, so rows keep their input order.
            </p>
          {/if}
        {/if}
      </section>

      {#if applied && issues.size === 0}
        <section class="step">
          <DownloadMenu
            primaryLabel="Download Layer"
            filenameStem={fileStem(files[0])}
            exportSource="schema_refactor"
          />
          <DownloadMenu
            primaryLabel="Download Crosswalk CSV"
            filenameStem={fileStem(files[0])}
            exportSource="schema_map"
          />
        </section>
      {/if}
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <MapTableSplit>
    {#snippet map()}
      <MapView
        originalGeojson={layerGeoJSON}
        bounds={loadedBounds}
        processing={loading || running}
        onFeatureClick={inspectAt}
        registerClear={(fn: () => void) => {
          clearMap = fn;
        }}
      />
    {/snippet}
    {#snippet table()}
      <ResultsTable
        {rows}
        values={selectedValues}
        {samples}
        {issues}
        emptyText={!loaded ? "Load a layer to see its crosswalk." : running ? "Mapping…" : undefined}
        onSetKeep={setKeep}
        onSetAllKeep={setAllKeep}
        onSetName={setName}
        onReset={resetRow}
        onResetAll={resetAll}
        onMove={moveRow}
        onSortDefault={sortToDefault}
        {inDefaultOrder}
        orderEdited={orderEdit !== null}
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

  summary.step-heading {
    cursor: pointer;
    user-select: none;
  }

  .step-body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
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

  .optional {
    font-weight: 400;
    color: var(--hdx-neutral-7);
    font-size: 0.85rem;
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

  .summary-line {
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
    line-height: 1.4;
    margin: 0;
  }

  .summary-line.warn {
    color: var(--hdx-warning-6);
  }

  .privacy {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    margin-top: auto;
  }
</style>
