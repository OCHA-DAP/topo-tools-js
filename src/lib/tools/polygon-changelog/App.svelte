<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import CrosswalkTable from "./CrosswalkTable.svelte";
  import MapView from "./MapView.svelte";
  import {
    PipelineError,
    reclassifyOnly,
    runFromLoaded,
    REL_ORDER,
    type RelClass,
    type TableRow,
    type ComparisonMethod,
  } from "./pipeline";
  import { detectColumns, type ColumnGuess } from "$lib/db/columns";
  import { buildKeyed, loadSide } from "./pipeline/load";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Load sources",
    "Build keyed layers",
    "Measure overlap",
    "Classify clusters",
    "Render result",
  ];

  // Input state
  let filesA = $state<File[]>([]);
  let filesB = $state<File[]>([]);
  let loadedA = $state(false);
  let loadedB = $state(false);
  let loadingSide = $state<"a" | "b" | null>(null);
  let loadError = $state<string | null>(null);
  let dropOpen = $state(true);

  // Auto-detected columns + user selections
  let colsA = $state<ColumnGuess | null>(null);
  let colsB = $state<ColumnGuess | null>(null);
  let aCodeCol = $state<string | null>(null);
  let aNameCol = $state<string | null>(null);
  let bCodeCol = $state<string | null>(null);
  let bNameCol = $state<string | null>(null);

  // Thresholds
  let tauMatch = $state(0.8);
  let tauSame = $state(0.98);

  // Matching mode: geometry-first (pure spatial) or identity-first (code/name
  // anchors take priority over spatial overlap). Identity mode uses whichever
  // code/name columns the user has already selected on each side.
  let matchMode = $state<"geometry" | "identity">("geometry");
  let linkMode = $state<"either" | "both">("either");
  const linkByCode = $derived(
    matchMode === "identity" && aCodeCol !== null && bCodeCol !== null,
  );
  const linkByName = $derived(matchMode === "identity" && aNameCol !== null && bNameCol !== null);

  // Pipeline run state
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-6=active, 7=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Which overlap method the last full run used (null until a run completes).
  let comparisonMethod = $state<ComparisonMethod | null>(null);

  // Results
  let overlayGeoJSON = $state<string | null>(null);
  let outlineAGeoJSON = $state<string | null>(null);
  let outlineBGeoJSON = $state<string | null>(null);
  let tableRows = $state<TableRow[]>([]);
  let bounds = $state<[number, number, number, number] | null>(null);

  // Selection / filter
  let selectedClusterId = $state<number | null>(null);
  let hoveredClusterId = $state<number | null>(null);
  let hoveredFid = $state<number | null>(null);
  // The currently hovered row's both-side fids. Set by both map hover (via a
  // tableRows lookup) and table hover. On a side toggle, hoveredFid is
  // re-derived from this row so the same logical row stays highlighted with
  // the correct side's fid — no flash, no stale per-side memory.
  let hoveredRow = $state<{
    cluster_id: number;
    a_fid: number | null;
    b_fid: number | null;
  } | null>(null);
  let visibleClasses = $state<Set<RelClass>>(new Set(REL_ORDER));

  // Comparison mode
  let showSide = $state<"a" | "b">("b");

  function handleKey(e: KeyboardEvent): void {
    if (!overlayGeoJSON) return;
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

  // Debounced reclassify on slider changes
  let reclassifyTimer: ReturnType<typeof setTimeout> | undefined;
  let reclassifying = $state(false);
  let reclassifyPending = false;

  // Auto-run when both sides are loaded. Re-dropping a file resets loadedA/B
  // to false then true again, which re-triggers the run.
  $effect(() => {
    const a = loadedA;
    const b = loadedB;
    if (!a || !b) return;
    untrack(() => {
      if (!running) handleRun();
    });
  });

  // Auto-load each side when files are dropped.
  // Re-dropping after a run reloads: stale dropdowns/results would otherwise
  // linger because loadedA/loadedB stayed true from the prior run.
  $effect(() => {
    const f = filesA;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "a") return;
      colsA = null;
      aCodeCol = null;
      aNameCol = null;
      loadedA = false;
      resetResults();
      loadSideThen("a");
    });
  });
  $effect(() => {
    const f = filesB;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "b") return;
      colsB = null;
      bCodeCol = null;
      bNameCol = null;
      loadedB = false;
      resetResults();
      loadSideThen("b");
    });
  });

  function resetResults(): void {
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    bounds = null;
    selectedClusterId = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "b";
    reclassifyPending = false;
    dropOpen = true;
    if (reclassifyTimer) {
      clearTimeout(reclassifyTimer);
      reclassifyTimer = undefined;
    }
  }

  async function loadSideThen(side: "a" | "b"): Promise<void> {
    loadError = null;
    loadingSide = side;
    try {
      const files = side === "a" ? filesA : filesB;
      await loadSide(duckdbState.db!, duckdbState.conn!, side, files);
      const cols = await detectColumns(duckdbState.conn!, `cw_${side}_layer_attr`);
      if (side === "a") {
        colsA = cols;
        aCodeCol = cols.code ?? null;
        aNameCol = cols.name;
        loadedA = true;
      } else {
        colsB = cols;
        bCodeCol = cols.code ?? null;
        bNameCol = cols.name;
        loadedB = true;
      }
      if (loadedA && loadedB) {
        const bboxResult = await duckdbState.conn!.query(`
          SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
                 MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
          FROM (SELECT geom FROM cw_a_layer_01 UNION ALL SELECT geom FROM cw_b_layer_01)
          WHERE geom IS NOT NULL
        `);
        const bboxRow = bboxResult.toArray()[0] as Record<string, number>;
        const { xmin, ymin, xmax, ymax } = bboxRow;
        if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
          bounds = [xmin, ymin, xmax, ymax];
        }
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingSide = null;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    selectedClusterId = null;
    currentStage = 1;
    errorStage = 0;
    stageLabel = "Sources loaded";
    try {
      const result = await runFromLoaded(
        duckdbState.conn!,
        {
          tauMatch,
          tauSame,
          aCodeCol: aCodeCol ? [aCodeCol] : [],
          aNameCol,
          bCodeCol: bCodeCol ? [bCodeCol] : [],
          bNameCol,
          linkByCode,
          linkByName,
          linkMode,
        },
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
      );
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
      bounds = result.bounds;
      if (result.method) comparisonMethod = result.method;
      currentStage = 7;
      stageLabel = "Done";
      dropOpen = false;
      exposeDebugHook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  $effect(() => {
    const _a = aCodeCol;
    const _b = bCodeCol;
    const _an = aNameCol;
    const _bn = bNameCol;
    untrack(() => {
      if (!overlayGeoJSON || running) return;
      handleApplyColumns();
    });
  });

  async function handleApplyColumns(): Promise<void> {
    if (!duckdbState.conn || !overlayGeoJSON) return;
    running = true;
    try {
      await buildKeyed(duckdbState.conn, "a", aCodeCol ? [aCodeCol] : [], aNameCol);
      await buildKeyed(duckdbState.conn, "b", bCodeCol ? [bCodeCol] : [], bNameCol);
      const result = await reclassifyOnly(duckdbState.conn, {
        tauMatch,
        tauSame,
        aCodeCol: aCodeCol ? [aCodeCol] : [],
        aNameCol,
        bCodeCol: bCodeCol ? [bCodeCol] : [],
        bNameCol,
        linkByCode,
        linkByName,
        linkMode,
      });
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function scheduleReclassify(): void {
    if (overlayGeoJSON == null) return;
    if (reclassifyTimer) clearTimeout(reclassifyTimer);
    if (reclassifying) {
      reclassifyPending = true;
      return;
    }
    reclassifyTimer = setTimeout(doReclassify, 100);
  }

  async function doReclassify(): Promise<void> {
    reclassifying = true;
    reclassifyPending = false;
    try {
      const result = await reclassifyOnly(duckdbState.conn!, {
        tauMatch,
        tauSame,
        aCodeCol: aCodeCol ? [aCodeCol] : [],
        aNameCol,
        bCodeCol: bCodeCol ? [bCodeCol] : [],
        bNameCol,
        linkByCode,
        linkByName,
        linkMode,
      });
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
      exposeDebugHook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      reclassifying = false;
      if (reclassifyPending) {
        reclassifyPending = false;
        setTimeout(doReclassify, 0);
      }
    }
  }

  function exposeDebugHook(): void {
    if (typeof window === "undefined") return;
    const summary: Record<string, number> = {};
    for (const c of REL_ORDER) summary[c] = 0;
    const seen = new Set<string>();
    for (const r of tableRows) {
      const key = r.cluster_id + ":" + r.relationship_class;
      if (seen.has(key)) continue;
      seen.add(key);
      summary[r.relationship_class] = (summary[r.relationship_class] ?? 0) + 1;
    }
    // Per-cluster counts are derived from unique cluster_id; a single cluster
    // might produce multiple rows so we de-dup by (cluster_id, class).
    const clusterCounts: Record<string, number> = {};
    for (const c of REL_ORDER) clusterCounts[c] = 0;
    const clusterClass = new Map<number, RelClass>();
    for (const r of tableRows) clusterClass.set(r.cluster_id, r.relationship_class);
    for (const cls of clusterClass.values()) clusterCounts[cls]++;
    (window as unknown as { __cw_debug: unknown }).__cw_debug = {
      done: currentStage === 7,
      summary: clusterCounts,
      tableRows,
      selectedClusterId,
      overlayGeoJSON,
    };
  }

  $effect(() => {
    // Update debug hook on selection changes so tests can observe state.
    selectedClusterId;
    if (overlayGeoJSON != null) untrack(exposeDebugHook);
  });

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 7) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function toggleClass(c: RelClass): void {
    const next = new Set(visibleClasses);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    visibleClasses = next;
  }

  function fileStem(a: File[], b: File[]): string {
    const stem = (files: File[]) => files[0]?.name.replace(/\.[^.]+$/, "") ?? "";
    const sa = stem(a);
    const sb = stem(b);
    if (!sa && !sb) return "changelog";
    if (!sa || !sb || sa === sb) return sa || sb;
    return `${sa}_${sb}`;
  }

  function setSelected(id: number | null): void {
    selectedClusterId = id;
  }

  function setHoveredFromMap(payload: { cluster_id: number | null; fid: number | null }): void {
    hoveredClusterId = payload.cluster_id;
    hoveredFid = payload.fid;
    if (payload.cluster_id == null || payload.fid == null) {
      hoveredRow = null;
      return;
    }
    // Look up the row whose current-side fid matches the hovered polygon, so
    // we know the other side's fid for free. A side toggle then re-derives
    // hoveredFid from this row instead of needing a cursor re-query.
    let found: { cluster_id: number; a_fid: number | null; b_fid: number | null } | null = null;
    for (const r of tableRows) {
      if (r.cluster_id !== payload.cluster_id) continue;
      const matches = showSide === "a" ? r.a_fid === payload.fid : r.b_fid === payload.fid;
      if (matches) {
        found = { cluster_id: r.cluster_id, a_fid: r.a_fid, b_fid: r.b_fid };
        break;
      }
    }
    hoveredRow = found;
  }

  function setHoveredFromRow(
    payload: { cluster_id: number | null; a_fid: number | null; b_fid: number | null } | null,
  ): void {
    if (payload == null || payload.cluster_id == null) {
      hoveredRow = null;
      hoveredClusterId = null;
      hoveredFid = null;
      return;
    }
    hoveredRow = { cluster_id: payload.cluster_id, a_fid: payload.a_fid, b_fid: payload.b_fid };
    hoveredClusterId = payload.cluster_id;
    hoveredFid = showSide === "a" ? payload.a_fid : payload.b_fid;
  }

  // Re-derive hoveredFid from the hovered row when the side toggles, so the
  // same row stays highlighted with the correct side's fid. Works for both
  // table-row hover and map hover (which populates hoveredRow via a tableRows
  // lookup), so toggles never flash through a stale per-side memory.
  $effect(() => {
    const side = showSide;
    const row = hoveredRow;
    if (row == null) return;
    untrack(() => {
      hoveredFid = side === "a" ? row.a_fid : row.b_fid;
    });
  });
</script>

<div class="cw-layout">
  <aside class="cw-sidebar">
    <header>
      <a class="cw-back" href={base}>← Topology Tools</a>
      <h1>Changelog</h1>
      <p class="cw-blurb">
        Compare two versions of a polygon layer (e.g. ADM2 across census rounds) and classify each
        unit as unchanged, modified, merged, split, created, or removed. Drop both versions; the
        tool overlays them, scores coverage per pair, and groups related polygons into clusters.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="cw-error">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <details class="cw-step" bind:open={dropOpen}>
      <summary class="cw-step-heading">Drop both layers</summary>
      <div class="cw-drop-body">
        <div class="cw-dropzones">
          <div data-testid="dropzone-a">
            <label class="cw-zone-label">Version A</label>
            <DropZone
              bind:files={filesA}
              disabled={running || loadingSide === "a"}
              helpText="Older version. Polygon layer in any supported format."
            />
          </div>
          <div data-testid="dropzone-b">
            <label class="cw-zone-label">Version B</label>
            <DropZone
              bind:files={filesB}
              disabled={running || loadingSide === "b"}
              helpText="Newer version. Same coverage area."
            />
          </div>
        </div>
        {#if loadingSide === "a"}<p class="cw-status">Loading Version A…</p>{/if}
        {#if loadingSide === "b"}<p class="cw-status">Loading Version B…</p>{/if}
        {#if loadError}<div class="cw-error">{loadError}</div>{/if}
        {#if running || errorStage > 0}
          <ol class="cw-stages">
            {#each STAGE_LABELS as label, i}
              {@const status = stageStatus(i)}
              <li class={status}>
                {#if status === "error"}
                  <span class="cw-stage-x">✕</span>
                {:else}
                  <span class="cw-stage-dot"></span>
                {/if}
                <span class="cw-stage-label">
                  {i + 1 === currentStage && stageLabel ? stageLabel : label}
                </span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if error}<div class="cw-error">{error}</div>{/if}
      </div>
    </details>

    {#if overlayGeoJSON || errorStage > 0}
    <section class="cw-step">
      <h2 class="cw-step-heading">Thresholds</h2>

      {#if comparisonMethod === "sampling"}
        <div class="cw-method cw-method--sampling">
          <span class="cw-method-label">
            Comparison method: <strong>point sampling</strong> (approximate, ±~1%)
          </span>
          <button type="button" class="cw-method-info" aria-label="About the comparison method">ⓘ</button>
          <span class="cw-tooltip" role="tooltip">
            Exact geometric intersection failed for this dataset — GEOS OverlayNG hits a
            floating-point bug in the browser's WASM engine on near-coincident boundaries (common
            when two versions are independent digitizations of the same coverage). Overlap was
            instead estimated by <strong>point sampling</strong>: a 32×32 grid of points per unit,
            counted into the other version's polygons. Coverage and IoU are estimates (≈±0.6% on
            tested data); the unchanged/modified line is reliable up to a 99% threshold, so the
            slider is capped there.
          </span>
        </div>
      {/if}

      <div class="cw-match-toggle" role="group" aria-label="Matching mode">
        <button
          class="cw-match-btn"
          class:active={matchMode === "geometry"}
          disabled={running}
          onclick={() => { matchMode = "geometry"; scheduleReclassify(); }}
        >Geometry first</button>
        <button
          class="cw-match-btn"
          class:active={matchMode === "identity" && linkMode === "either"}
          disabled={running}
          onclick={() => { matchMode = "identity"; linkMode = "either"; scheduleReclassify(); }}
        >Code or name</button>
        <button
          class="cw-match-btn"
          class:active={matchMode === "identity" && linkMode === "both"}
          disabled={running}
          onclick={() => { matchMode = "identity"; linkMode = "both"; scheduleReclassify(); }}
        >Code and name</button>
      </div>
      <p class="cw-hint">
        {#if matchMode === "geometry"}
          Units matched by spatial overlap only.
        {:else if linkMode === "either"}
          Pairs units sharing a unique code <em>or</em> name even without overlap, so moved units
          are classified as <em>relocated</em>, <em>modified</em>, or <em>renamed</em> instead of
          merge/split/complex.
        {:else}
          Pairs units sharing a unique code <em>and</em> name even without overlap, so moved units
          are classified as <em>relocated</em>, <em>modified</em>, or <em>renamed</em> instead of
          merge/split/complex.
        {/if}
      </p>

      <label class="cw-slider">
        <span>Matched — {Math.round(tauSame * 100)}%</span>
        <input
          type="range"
          min="0"
          max={comparisonMethod === "sampling" ? "0.99" : "1"}
          step="0.01"
          bind:value={tauSame}
          oninput={scheduleReclassify}
          disabled={running}
        />
        <p class="cw-hint">
          How much a 1:1 matched pair must overlap (IoU) to be classified as
          <em>unchanged</em> rather than <em>modified</em>.{#if comparisonMethod === "sampling"}
            {" "}Capped at 99% — sampling can't reliably distinguish near-identical from bit-identical geometry.
          {/if}
        </p>
      </label>

      <label class="cw-slider">
        <span>Related — {Math.round(tauMatch * 100)}%</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          bind:value={tauMatch}
          oninput={scheduleReclassify}
          disabled={running}
        />
        <p class="cw-hint">
          How much of either polygon must overlap the other to be considered related.
          Lower = more units linked.
        </p>
      </label>

    </section>

    <section class="cw-step">
      <h2 class="cw-step-heading">Pick code &amp; name columns</h2>
        <div class="cw-cols">
          {#if colsA}
            <fieldset class="cw-fieldset">
              <legend>Version A</legend>
              <label class="cw-field">
                <span>Code</span>
                <select bind:value={aCodeCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsA.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
              <label class="cw-field">
                <span>Name</span>
                <select bind:value={aNameCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsA.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
            </fieldset>
          {/if}
          {#if colsB}
            <fieldset class="cw-fieldset">
              <legend>Version B</legend>
              <label class="cw-field">
                <span>Code</span>
                <select bind:value={bCodeCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsB.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
              <label class="cw-field">
                <span>Name</span>
                <select bind:value={bNameCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsB.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
            </fieldset>
          {/if}
        </div>
    </section>
    {/if}

    {#if overlayGeoJSON}
      <section class="cw-step">
        <h2 class="cw-step-heading">Download</h2>
        <div class="cw-downloads">
          <DownloadMenu
            primaryLabel="Changelog CSV"
            filenameStem={fileStem(filesA, filesB)}
            exportSource="crosswalk_changelog"
          />
        </div>
      </section>
    {/if}

    <p class="cw-privacy">Your files never leave your device.</p>
  </aside>

  <div class="cw-result">
    <div class="cw-map-pane">
      {#if overlayGeoJSON}
        <div class="cw-view-toolbar">
          <div class="cw-mode-btns" role="group" aria-label="View mode">
            <button
              class="cw-mode-btn"
              class:active={showSide === "a"}
              onclick={() => (showSide = "a")}>Version A</button
            >
            <button
              class="cw-mode-btn"
              class:active={showSide === "b"}
              onclick={() => (showSide = "b")}>Version B</button
            >
          </div>
          <p class="cw-kbd-hint"><kbd>[</kbd><kbd>]</kbd> to cycle</p>
        </div>
      {/if}

      <MapView
        overlayGeojson={overlayGeoJSON}
        outlineAGeojson={outlineAGeoJSON}
        outlineBGeojson={outlineBGeoJSON}
        {bounds}
        processing={(loadedA && loadedB) || running}
        {hoveredClusterId}
        {hoveredFid}
        {visibleClasses}
        onClusterClick={setSelected}
        onFeatureHover={setHoveredFromMap}
        {showSide}
      />
    </div>
    <div class="cw-table-pane">
      <CrosswalkTable
        rows={tableRows}
        {selectedClusterId}
        {hoveredClusterId}
        {hoveredFid}
        {showSide}
        {visibleClasses}
        onRowHover={setHoveredFromRow}
        onToggleClass={toggleClass}
        onSetSide={(side) => (showSide = side)}
      />
    </div>
  </div>
</div>

<style>
  .cw-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: 100dvh;
    overflow: hidden;
  }
  .cw-sidebar {
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
  .cw-back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin-bottom: 0.5rem;
  }
  .cw-back:hover {
    color: #111;
  }
  .cw-blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }
  .cw-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }
  .cw-drop-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .cw-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }
  summary.cw-step-heading {
    cursor: pointer;
    user-select: none;
  }
  summary.cw-step-heading:hover {
    color: #374151;
  }
  .cw-dropzones {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-zone-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    margin-bottom: 0.2rem;
  }
  .cw-cols {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
  }
  .cw-fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    padding: 0 0.3rem;
  }
  .cw-field {
    display: grid;
    grid-template-columns: 60px 1fr;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
    font-size: 0.8rem;
  }
  .cw-field select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #fff;
  }
  .cw-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .cw-slider input[type="range"] {
    width: 100%;
  }
  .cw-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.3;
  }
  .cw-method {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: #4b5563;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    margin: 0 0 0.75rem;
  }
  .cw-method--sampling {
    background: #fef3c7;
    border-color: #fcd34d;
    color: #78350f;
  }
  .cw-method-label strong {
    color: #1f2937;
  }
  .cw-method--sampling .cw-method-label strong {
    color: #78350f;
  }
  .cw-method-info {
    margin-left: auto;
    flex-shrink: 0;
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    color: #6b7280;
    font-size: 0.85rem;
    cursor: help;
    padding: 0;
  }
  .cw-method-info:hover,
  .cw-method-info:focus-visible {
    color: #2563eb;
  }
  .cw-tooltip {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 0.3rem;
    z-index: 30;
    background: #1f2937;
    color: #f3f4f6;
    font-size: 0.72rem;
    line-height: 1.45;
    padding: 0.55rem 0.7rem;
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.12s ease;
    pointer-events: none;
  }
  .cw-tooltip strong {
    color: #fff;
  }
  .cw-method:hover .cw-tooltip,
  .cw-method:focus-within .cw-tooltip {
    opacity: 1;
    visibility: visible;
  }
  .cw-match-toggle {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 0.35rem;
  }
  .cw-match-btn {
    flex: 1;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    border: none;
    border-left: 1px solid #d1d5db;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
  }
  .cw-match-btn:first-child {
    border-left: none;
  }
  .cw-match-btn:hover:not(:disabled) {
    background: #f9fafb;
    color: #374151;
  }
  .cw-match-btn.active {
    background: #f3f4f6;
    color: #111;
    font-weight: 600;
  }
  .cw-match-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cw-status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
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
  .cw-error {
    padding: 0.6rem 0.8rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    color: #b91c1c;
    font-size: 0.8rem;
    word-break: break-word;
  }
  .cw-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .cw-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: #6b7280;
  }
  .cw-stages li.done {
    color: #047857;
  }
  .cw-stages li.active {
    color: #1d4ed8;
    font-weight: 600;
    animation: pulse 1s ease-in-out infinite;
  }
  .cw-stages li.error {
    color: #b91c1c;
    font-weight: 600;
  }
  .cw-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .cw-stages li.active .cw-stage-dot {
    opacity: 1;
  }
  .cw-stages li.done .cw-stage-dot {
    opacity: 1;
  }
  .cw-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .cw-downloads {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .cw-privacy {
    margin: 0;
    padding-top: 0.5rem;
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .cw-result {
    display: grid;
    grid-template-rows: 65% 35%;
    height: 100dvh;
    min-width: 0;
  }
  .cw-map-pane {
    min-height: 0;
    border-bottom: 1px solid #e5e7eb;
    position: relative;
  }

  .cw-view-toolbar {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
    pointer-events: auto;
  }

  .cw-mode-btns {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .cw-mode-btn {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
    border-left: 1px solid #e5e7eb;
    transition:
      background 0.1s,
      color 0.1s;
  }

  .cw-mode-btn:first-child {
    border-left: none;
  }

  .cw-kbd-hint {
    margin: 0;
    font-size: 0.7rem;
    color: #6b7280;
    text-align: right;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.2rem 0.45rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .cw-kbd-hint kbd {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f3f4f6;
    color: #4b5563;
  }

  .cw-mode-btn:hover {
    background: #f3f4f6;
    color: #111;
  }

  .cw-mode-btn.active {
    background: #111;
    color: #fff;
  }

  .cw-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .cw-result {
      grid-template-rows: 1fr;
      grid-template-columns: 65% 35%;
    }
    .cw-map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
</style>
