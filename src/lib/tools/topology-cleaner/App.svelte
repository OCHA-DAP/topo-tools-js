<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { onMount, untrack } from "svelte";
  import IssuesTable from "./IssuesTable.svelte";
  import MapView from "./MapView.svelte";
  import {
    PipelineError,
    recleanOnly,
    resolveGapFillWidths,
    runFromLoaded,
    type ExportCheck,
    type IssueKind,
    type IssueRow,
  } from "./pipeline";
  import { niceNum } from "./pipeline/units";

  const STAGE_LABELS = ["Load file", "Analyze coverage", "Find gaps & overlaps", "Fix topology"];

  // Input
  let files = $state<File[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  // Gap-fill mode: auto (default, sliver-shaped gaps only), all (every
  // detected gap), or manual (exact width via the slider below).
  let mode = $state<"auto" | "all" | "manual">("auto");

  // Manual-mode slider (meters). Only read when mode === "manual".
  let gapWidthM = $state(0);

  function fmtGap(m: number): string {
    if (m === 0) return "none";
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    if (m >= 1) return `${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 2 : 1)} m`;
    if (m >= 0.01) return `${(m * 100).toFixed(1)} cm`;
    return `${(m * 1000).toFixed(1)} mm`;
  }

  // allFillM: 2× the widest detected gap (All mode, and the Manual slider's
  // ceiling). autoFillM: 2× the widest gap shaped like a digitization
  // sliver (Auto mode) — 0 when no gap qualifies, meaning "fill nothing."
  const { allFillM, autoFillM } = $derived(resolveGapFillWidths(issues));

  const gapMaxM = $derived(allFillM || 100);
  const gapStepM = $derived(niceNum(gapMaxM / 100));

  // The width actually fed to ST_CoverageClean, driven by the active mode.
  const effectiveGapWidthM = $derived(
    mode === "manual" ? gapWidthM : mode === "all" ? allFillM : autoFillM,
  );

  function setMode(next: "auto" | "all" | "manual"): void {
    // Seed the slider from whatever's currently applied so switching into
    // Manual never itself changes what gets filled — only future drags do.
    if (next === "manual" && mode !== "manual") {
      gapWidthM = effectiveGapWidthM;
    }
    mode = next;
    scheduleReclean();
  }

  // Clamp the manual slider if the max drops below it.
  $effect(() => {
    const max = gapMaxM;
    untrack(() => {
      if (mode === "manual" && gapWidthM > max) {
        gapWidthM = max;
        scheduleReclean();
      }
    });
  });

  // Run state
  let running = $state(false);
  let currentStage = $state(0); // 0 idle, 1..4 active, 5 done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Results
  let originalGeoJSON = $state<string | null>(null);
  let cleanedGeoJSON = $state<string | null>(null);
  let issuesGeoJSON = $state<string | null>(null);
  let issues = $state<IssueRow[]>([]);
  let fixedKeys = $state<Set<string>>(new Set());
  let detectionFailed = $state<Set<IssueKind>>(new Set());
  let exportCheck = $state<ExportCheck | null>(null);
  let bounds = $state<[number, number, number, number] | null>(null);
  let totalCount = $state(0);
  let collapsedCount = $state(0);

  // View + selection
  let showSide = $state<"a" | "b">("b");
  let selectedKey = $state<string | null>(null);
  let focusBbox = $state<[number, number, number, number] | null>(null);

  // Debounce for slider-driven re-clean.
  let recleanTimer: ReturnType<typeof setTimeout> | undefined;
  let recleaning = $state(false);
  let recleanPending = false;

  function handleKey(e: KeyboardEvent): void {
    if (!cleanedGeoJSON) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "]" || e.key === "[") {
      showSide = showSide === "a" ? "b" : "a";
    }
  }

  onMount(() => {
    initDuckDB();
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });

  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loading) return;
      loaded = false;
      resetResults();
      loadThenFlag();
    });
  });

  $effect(() => {
    const ok = loaded;
    if (!ok) return;
    untrack(() => {
      if (!running) handleRun();
    });
  });

  function resetResults(): void {
    originalGeoJSON = null;
    cleanedGeoJSON = null;
    issuesGeoJSON = null;
    issues = [];
    fixedKeys = new Set();
    detectionFailed = new Set();
    exportCheck = null;
    bounds = null;
    totalCount = 0;
    collapsedCount = 0;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "b";
    selectedKey = null;
    focusBbox = null;
    mode = "auto";
    gapWidthM = 0;
    recleanPending = false;
    if (recleanTimer) {
      clearTimeout(recleanTimer);
      recleanTimer = undefined;
    }
  }

  async function loadThenFlag(): Promise<void> {
    loadError = null;
    loading = true;
    currentStage = 1;
    stageLabel = "Loading file…";
    try {
      await loadFile(duckdbState.db!, duckdbState.conn!, files);
      loaded = true;
      const bboxResult = await duckdbState.conn!.query(`
        SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
               MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
        FROM layer_01 WHERE geom IS NOT NULL
      `);
      const bboxRow = bboxResult.toArray()[0] as Record<string, number>;
      const { xmin, ymin, xmax, ymax } = bboxRow;
      if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
        bounds = [xmin, ymin, xmax, ymax];
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      currentStage = 0;
    } finally {
      loading = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    errorStage = 0;
    try {
      const result = await runFromLoaded(duckdbState.conn!, (stage, label) => {
        currentStage = stage;
        stageLabel = label;
      });
      originalGeoJSON = result.originalGeoJSON;
      cleanedGeoJSON = result.cleanedGeoJSON;
      issuesGeoJSON = result.issuesGeoJSON;
      issues = result.issues;
      fixedKeys = result.fixedKeys;
      detectionFailed = result.detectionFailed;
      exportCheck = result.exportCheck;
      bounds = result.bounds;
      totalCount = result.totalCount;
      collapsedCount = result.collapsedCount;
      currentStage = 5;
      stageLabel = "Done";
      showSide = "b";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  function scheduleReclean(): void {
    if (cleanedGeoJSON == null) return;
    if (recleanTimer) clearTimeout(recleanTimer);
    if (recleaning) {
      recleanPending = true;
      return;
    }
    recleanTimer = setTimeout(doReclean, 200);
  }

  async function doReclean(): Promise<void> {
    recleaning = true;
    recleanPending = false;
    try {
      const result = await recleanOnly(duckdbState.conn!, { gapWidthM: effectiveGapWidthM });
      cleanedGeoJSON = result.cleanedGeoJSON;
      collapsedCount = result.collapsedCount;
      fixedKeys = result.fixedKeys;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      detectionFailed = result.detectionFailed;
      exportCheck = result.exportCheck;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      recleaning = false;
      if (recleanPending) {
        recleanPending = false;
        setTimeout(doReclean, 0);
      }
    }
  }

  // Selecting an issue (from table or map) highlights it, switches to Version A
  // so the highlight is visible over the original coverage, and zooms to it.
  function selectIssue(key: string): void {
    const row = issues.find((r) => r.key === key);
    if (!row) return;
    selectedKey = key;
    showSide = "a";
    focusBbox = row.bbox.slice() as [number, number, number, number]; // fresh array → always re-zooms
  }

  function onMapIssueClick(key: string | null): void {
    if (key == null) {
      selectedKey = null;
      return;
    }
    selectIssue(key);
  }

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 5) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(f: File[]): string {
    return f[0]?.name.replace(/\.[^.]+$/, "") ?? "coverage";
  }
</script>

<div class="tc-layout">
  <aside class="tc-sidebar">
    <header>
      <a class="tc-back" href="/">← Topology Tools</a>
      <h1>Topology Cleaner</h1>
      <p class="tc-blurb">
        Drop a polygon layer to detect and fix overlaps and gaps. Click any issue to zoom to it.
        By default only digitization-sliver-shaped gaps get filled — switch modes or use the
        slider to control how much gets filled.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="tc-error"><strong>Initialisation error:</strong> {duckdbState.initError}</div>
    {/if}

    <section class="tc-step">
      <h2 class="tc-step-heading">Drop a polygon layer</h2>
      <DropZone
        bind:files
        disabled={running || loading}
        helpText="Polygon coverage in any supported format — adjacent admin units, basins, etc."
      />
      {#if loading}<p class="tc-status">Loading…</p>{/if}
      {#if loadError}<div class="tc-error">{loadError}</div>{/if}
    </section>

    {#if cleanedGeoJSON}
      <section class="tc-step">
        <h2 class="tc-step-heading">Gap width</h2>
        <div class="tc-mode-btns" role="group" aria-label="Gap-fill mode">
          <button
            class="tc-mode-btn"
            class:active={mode === "auto"}
            disabled={running}
            onclick={() => setMode("auto")}>Auto</button
          >
          <button
            class="tc-mode-btn"
            class:active={mode === "all"}
            disabled={running}
            onclick={() => setMode("all")}>All</button
          >
          <button
            class="tc-mode-btn"
            class:active={mode === "manual"}
            disabled={running}
            onclick={() => setMode("manual")}>Manual</button
          >
        </div>
        {#if mode === "manual"}
          <label class="tc-slider">
            <span>Fill gaps up to — {fmtGap(gapWidthM)}</span>
            <input
              type="range"
              min="0"
              max={gapMaxM}
              step={gapStepM}
              bind:value={gapWidthM}
              oninput={scheduleReclean}
              disabled={running}
            />
            <p class="tc-hint">Fill enclosed gaps up to this width. Raise to close larger gaps.</p>
          </label>
        {:else}
          <p class="tc-hint">
            {#if effectiveGapWidthM > 0}
              Filling gaps up to {fmtGap(effectiveGapWidthM)}.
            {:else}
              No gaps will be filled.
            {/if}
            {#if mode === "auto"}
              Only gaps shaped like digitization slivers are filled, regardless of width — real
              enclosed features (a pond, a missing unit) are left alone.
            {:else}
              Every detected gap is filled.
            {/if}
          </p>
        {/if}
      </section>
    {/if}

    {#if loading || running || recleaning || errorStage > 0}
      <ol class="tc-stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}<span class="tc-stage-x">✕</span>{:else}<span
                class="tc-stage-dot"
              ></span>{/if}
            <span>{i + 1 === currentStage && stageLabel ? stageLabel : label}</span>
          </li>
        {/each}
        {#if recleaning}
          <li class="active" role="status" aria-live="polite">
            <span class="tc-spinner" aria-hidden="true"></span>
            <span
              >{effectiveGapWidthM > 0
                ? `Filling gaps up to ${fmtGap(effectiveGapWidthM)}…`
                : "Fixing overlaps…"}</span
            >
          </li>
        {/if}
      </ol>
    {/if}

    {#if error}<div class="tc-error">{error}</div>{/if}

    {#if cleanedGeoJSON && collapsedCount > 0}
      <p class="tc-warn">{collapsedCount} of {totalCount} polygons were dropped — the input has crossing-boundary defects that could not be resolved even with automatic snapping.</p>
    {/if}

    {#if cleanedGeoJSON}
      <section class="tc-step">
        <h2 class="tc-step-heading">Download</h2>
        {#if exportCheck}
          {#if exportCheck.checkFailed}
            <p class="tc-export-check tc-export-check--fail">
              ⚠ Couldn't fully verify the export — GEOS failed to check it, even after retrying.
              Inspect the download in GIS software before relying on it.
            </p>
          {:else if exportCheck.invalidCount === 0 && exportCheck.residualGaps === 0 && exportCheck.residualOverlaps === 0}
            <p class="tc-export-check tc-export-check--ok">
              ✓ Export verified: {exportCheck.rowCount} valid polygons, no gaps or overlaps remain.
            </p>
          {:else}
            <p class="tc-export-check tc-export-check--warn">
              ⚠ Export check found
              {#if exportCheck.invalidCount > 0}{exportCheck.invalidCount} invalid {exportCheck.invalidCount === 1 ? "geometry" : "geometries"}{/if}
              {#if exportCheck.invalidCount > 0 && (exportCheck.residualGaps > 0 || exportCheck.residualOverlaps > 0)}, {/if}
              {#if exportCheck.residualGaps > 0}{exportCheck.residualGaps} residual {exportCheck.residualGaps === 1 ? "gap" : "gaps"}{/if}
              {#if exportCheck.residualGaps > 0 && exportCheck.residualOverlaps > 0}, {/if}
              {#if exportCheck.residualOverlaps > 0}{exportCheck.residualOverlaps} residual {exportCheck.residualOverlaps === 1 ? "overlap" : "overlaps"}{/if}
              in the exported output.
            </p>
          {/if}
        {/if}
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files)}
          cachedGeoJSON={cleanedGeoJSON}
          exportSource="clean_topology"
        />
      </section>
    {/if}

    {#if cleanedGeoJSON && issues.length > 0}
      <section class="tc-step">
        <h2 class="tc-step-heading">Download issues</h2>
        <p class="tc-hint">
          Just the detected gaps and overlaps — open in QGIS or ArcGIS to inspect or fix them
          yourself.
        </p>
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(files)}
          cachedGeoJSON={issuesGeoJSON}
          exportSource="topology_issues"
          variant="secondary"
        />
      </section>
    {/if}

    <p class="tc-privacy">Your files never leave your device.</p>
  </aside>

  <div class="tc-result">
    <div class="tc-map-pane">
      {#if cleanedGeoJSON}
        <div class="tc-view-toolbar">
          <div class="tc-mode-btns" role="group" aria-label="View mode">
            <button
              class="tc-mode-btn"
              class:active={showSide === "a"}
              onclick={() => (showSide = "a")}>Original</button
            >
            <button
              class="tc-mode-btn"
              class:active={showSide === "b"}
              onclick={() => (showSide = "b")}>Fixed</button
            >
          </div>
          <p class="tc-kbd-hint"><kbd>[</kbd><kbd>]</kbd> to cycle</p>
        </div>
      {/if}
      <MapView
        originalGeojson={originalGeoJSON}
        cleanedGeojson={cleanedGeoJSON}
        issuesGeojson={issuesGeoJSON}
        {bounds}
        {focusBbox}
        {selectedKey}
        {showSide}
        processing={loading || running}
        onIssueClick={onMapIssueClick}
      />
    </div>
    {#if cleanedGeoJSON}
      <div class="tc-table-pane">
        <IssuesTable
          rows={issues}
          {selectedKey}
          {fixedKeys}
          {detectionFailed}
          onSelect={selectIssue}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .tc-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: 100dvh;
    overflow: hidden;
  }
  .tc-sidebar {
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
  .tc-back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin-bottom: 0.5rem;
  }
  .tc-back:hover {
    color: #111;
  }
  .tc-blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }
  .tc-blurb code {
    font-size: 0.78rem;
    background: #f3f4f6;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
  }
  .tc-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }
  .tc-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }
  .tc-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .tc-slider input[type="range"] {
    width: 100%;
  }
  .tc-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.3;
  }
  .tc-num-input {
    width: 100%;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    color: #374151;
    background: #fff;
  }
  .tc-num-input:disabled {
    background: #f9fafb;
    color: #9ca3af;
  }
  .tc-status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
  }
  .tc-error {
    padding: 0.6rem 0.8rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    color: #b91c1c;
    font-size: 0.8rem;
    word-break: break-word;
  }
  .tc-warn {
    margin: 0;
    font-size: 0.8rem;
    color: #b45309;
    font-weight: 600;
  }
  .tc-export-check {
    margin: 0 0 0.6rem;
    padding: 0.5rem 0.65rem;
    font-size: 0.78rem;
    border-radius: 4px;
  }
  .tc-export-check--ok {
    color: #15803d;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
  }
  .tc-export-check--warn {
    color: #92400e;
    background: #fffbeb;
    border: 1px solid #fde68a;
  }
  .tc-export-check--fail {
    color: #b91c1c;
    background: #fef2f2;
    border: 1px solid #fecaca;
  }
  .tc-stages {
    list-style: none;
    padding: 0.75rem 0 0;
    margin: 0;
    border-top: 1px solid #e5e7eb;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .tc-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: #6b7280;
  }
  .tc-stages li.done {
    color: #047857;
  }
  .tc-stages li.active {
    color: #1d4ed8;
    font-weight: 600;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .tc-stages li.error {
    color: #b91c1c;
    font-weight: 600;
  }
  .tc-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .tc-stages li.active .tc-stage-dot,
  .tc-stages li.done .tc-stage-dot {
    opacity: 1;
  }
  .tc-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .tc-privacy {
    margin: 0;
    padding-top: 0.5rem;
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .tc-result {
    display: grid;
    grid-template-rows: 60% 40%;
    height: 100dvh;
    min-width: 0;
  }
  .tc-map-pane {
    position: relative;
    min-height: 0;
    border-bottom: 1px solid #e5e7eb;
  }
  .tc-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .tc-result {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr 360px;
    }
    .tc-map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
  .tc-spinner {
    width: 8px;
    height: 8px;
    border: 1.5px solid #bfdbfe;
    border-top-color: #1d4ed8;
    border-radius: 50%;
    animation: tc-spin 0.4s linear infinite;
  }
  @keyframes tc-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tc-view-toolbar {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }
  .tc-mode-btns {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-mode-btn {
    appearance: none;
    -webkit-appearance: none;
    flex: 1 1 0;
    padding: 0.3rem 0.6rem;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
    border-left: 1px solid #e5e7eb;
    text-align: center;
  }
  .tc-mode-btn:first-child {
    border-left: none;
  }
  .tc-mode-btn:hover:not(:disabled) {
    background: #f3f4f6;
    color: #374151;
  }
  .tc-mode-btn.active {
    background: #374151;
    color: #fff;
  }
  .tc-mode-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .tc-kbd-hint {
    margin: 0;
    font-size: 0.7rem;
    color: #6b7280;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.2rem 0.45rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-kbd-hint kbd {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f3f4f6;
    color: #4b5563;
  }
</style>
