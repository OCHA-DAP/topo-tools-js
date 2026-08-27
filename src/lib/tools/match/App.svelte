<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "./MapView.svelte";
  import { runEdgeMatch, type EdgeMatchPhase } from "./pipeline/index";
  import type { GroupResult } from "./pipeline/groups";
  import type { ColumnGuess } from "$lib/db/columns";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Load file",
    "Extract boundary lines",
    "Interpolate points",
    "Build Voronoi diagram",
    "Merge polygons",
  ];

  type GroupRow = GroupResult | { parentFid: number; label: string; childCount: number; status: "pending" | "running" };

  let childFiles = $state<File[]>([]);
  let parentFiles = $state<File[]>([]);
  let running = $state(false);
  let phaseLabel = $state("");
  let error = $state<string | null>(null);

  let groupRows = $state<GroupRow[]>([]);
  let activeGroupIndex = $state(-1);
  let activeStage = $state(0);

  let resultGeoJSON = $state<string | null>(null);
  let parentOutlineGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let unassignedCount = $state<number | null>(null);
  let droppedCount = $state<number | null>(null);
  let passthroughCount = $state<number | null>(null);
  let codeMismatchCount = $state<number | null>(null);
  let codeFallbackCount = $state<number | null>(null);
  let passthrough = $state(false);

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior, even when a plausible code column
  // exists. Repicking after a run reruns the whole pipeline, since a
  // reassigned child can move to a different group entirely.
  let childColumns = $state<ColumnGuess | null>(null);
  let parentColumns = $state<ColumnGuess | null>(null);
  let childMatchColumn = $state<string | null>(null);
  let parentMatchColumn = $state<string | null>(null);

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    if (duckdbState.ready) {
      // @ts-expect-error temporary debug hook, removed after manual QA
      window.__dbg = { conn: duckdbState.conn, db: duckdbState.db };
    }
  });

  $effect(() => {
    const f = childFiles;
    const c = parentFiles;
    if (f.length > 0 && c.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (running) return;
        childColumns = null;
        parentColumns = null;
        childMatchColumn = null;
        parentMatchColumn = null;
        handleRun();
      });
    }
  });

  // Repicking the code-join column after the first run reruns the whole
  // pipeline: a reassigned child can move to a different group entirely, so
  // there is no cheaper partial-recompute path here (unlike Changelog's).
  $effect(() => {
    const _c = childMatchColumn;
    const _p = parentMatchColumn;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      if ((childMatchColumn == null) !== (parentMatchColumn == null)) return;
      handleRun();
    });
  });

  $effect(() => {
    const _p = passthrough;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      handleRun();
    });
  });

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  function onProgress(event: EdgeMatchPhase): void {
    switch (event.phase) {
      case "loading":
        phaseLabel = "Loading files…";
        break;
      case "assigning":
        phaseLabel = "Computing overlap assignment…";
        break;
      case "groups-listed":
        phaseLabel = `Running ${event.groups.length} group${event.groups.length === 1 ? "" : "s"}…`;
        groupRows = event.groups.map((g) => ({ ...g, status: "pending" as const }));
        break;
      case "group-stage":
        activeGroupIndex = event.groupIndex;
        activeStage = event.stage;
        groupRows[event.groupIndex] = { ...event.group, status: "running" };
        break;
      case "group-done":
        groupRows[event.groupIndex] = event.result;
        if (activeGroupIndex === event.groupIndex) activeStage = 0;
        break;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resultGeoJSON = null;
    parentOutlineGeoJSON = null;
    resultBounds = null;
    unassignedCount = null;
    droppedCount = null;
    passthroughCount = null;
    codeMismatchCount = null;
    codeFallbackCount = null;
    groupRows = [];
    activeGroupIndex = -1;
    activeStage = 0;
    phaseLabel = "";

    try {
      const result = await runEdgeMatch(
        duckdbState.db!,
        duckdbState.conn!,
        childFiles,
        parentFiles,
        onProgress,
        { parentMatchColumn: parentMatchColumn ?? undefined, childMatchColumn: childMatchColumn ?? undefined },
        passthrough,
      );
      resultGeoJSON = result.geojson;
      parentOutlineGeoJSON = result.parentOutlineGeojson;
      resultBounds = result.bounds;
      unassignedCount = result.unassignedCount;
      droppedCount = result.droppedCount;
      passthroughCount = result.passthroughCount;
      codeMismatchCount = result.codeMismatchCount;
      codeFallbackCount = result.codeFallbackCount;
      childColumns = result.childColumns;
      parentColumns = result.parentColumns;
      phaseLabel = "Done";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
      activeGroupIndex = -1;
      activeStage = 0;
    }
  }

  function stageStatus(idx: number): "pending" | "active" | "done" {
    const stageNum = idx + 1;
    if (activeStage === 0) return "pending";
    if (stageNum < activeStage) return "done";
    if (stageNum === activeStage) return "active";
    return "pending";
  }

  const doneCount = $derived(groupRows.filter((g) => g.status === "done").length);
  const errorCount = $derived(groupRows.filter((g) => g.status === "error").length);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Edge Matcher</h1>
      <p class="blurb">
        Match a fine polygon layer to whichever coarse boundary polygon it overlaps the most, then
        extend each group's edges outward so every group's result meets its boundary exactly.
        Works the same whether the two layers are adjacent levels (admin 4 into 3) or far apart
        (admin 4 straight into 0).
      </p>
      <p class="hint">
        Coarse layer should be a clean coverage — run Topology Cleaner first if unsure.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <h2 class="step-heading">Fine layer</h2>
      <DropZone
        bind:files={childFiles}
        disabled={running}
        helpText="The layer to match and extend — any polygon set, any admin level. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Coarse layer</h2>
      <DropZone
        bind:files={parentFiles}
        disabled={running}
        helpText="The boundary to match and clip against, one level up or many."
      />
    </section>

    {#if childColumns && parentColumns}
      <section class="step">
        <h2 class="step-heading">Code join (optional)</h2>
        <p class="hint">
          Wins over spatial overlap wherever the codes agree on a parent the child overlaps at all,
          falls back to spatial when no code match exists.
        </p>
        <div class="match-cols">
          <label class="match-field">
            <span>Fine code</span>
            <select bind:value={childMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each childColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
          <label class="match-field">
            <span>Coarse code</span>
            <select bind:value={parentMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each parentColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
        </div>
      </section>
    {/if}

    {#if childColumns && parentColumns}
      <section class="step">
        <h2 class="step-heading">Unmatched fine units</h2>
        <label class="passthrough-field">
          <input type="checkbox" bind:checked={passthrough} disabled={running} />
          <span>Include zero-overlap units unclipped, instead of dropping them</span>
        </label>
      </section>
    {/if}

    {#if running || groupRows.length > 0}
      <section class="step">
        <p class="phase-label">{phaseLabel}</p>

        {#if groupRows.length > 0}
          <p class="group-summary">
            {doneCount}/{groupRows.length} groups done{errorCount > 0 ? ` · ${errorCount} failed` : ""}
          </p>
          <ol class="groups">
            {#each groupRows as row, i}
              <li class={row.status}>
                <span class="group-row">
                  {#if row.status === "done"}
                    <span class="group-dot">✓</span>
                  {:else if row.status === "error"}
                    <span class="group-dot">✕</span>
                  {:else}
                    <span class="group-dot">•</span>
                  {/if}
                  <span class="group-label">{row.label}</span>
                  <span class="group-count">{row.childCount}</span>
                </span>
                {#if i === activeGroupIndex && running}
                  <ol class="stages">
                    {#each STAGE_LABELS as label, si}
                      <li class={stageStatus(si)}>
                        <span class="stage-dot"></span>
                        <span class="stage-label">{label}</span>
                      </li>
                    {/each}
                  </ol>
                {/if}
                {#if row.status === "error" && "error" in row}
                  <p class="group-error">{row.error}</p>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if (unassignedCount !== null && unassignedCount > 0) || (droppedCount !== null && droppedCount > 0) || (codeMismatchCount !== null && codeMismatchCount > 0) || (codeFallbackCount !== null && codeFallbackCount > 0)}
      <div class="warn-panel">
        {#if unassignedCount !== null && unassignedCount > 0}
          <p>
            {unassignedCount} fine unit{unassignedCount === 1 ? "" : "s"} had no overlap with any
            coarse polygon{passthrough
              ? `; ${passthroughCount ?? 0} ${(passthroughCount ?? 0) === 1 ? "was" : "were"} extended and included unclipped`
              : ` and ${unassignedCount === 1 ? "was" : "were"} excluded from the result`}.
          </p>
        {/if}
        {#if droppedCount !== null && droppedCount > 0}
          <p>
            {droppedCount} fine unit{droppedCount === 1 ? "" : "s"} belonged to a group whose
            extension failed and {droppedCount === 1 ? "was" : "were"} excluded from the result.
          </p>
        {/if}
        {#if codeMismatchCount !== null && codeMismatchCount > 0}
          <p>
            {codeMismatchCount} unit{codeMismatchCount === 1 ? "" : "s"} matched by code to a
            different parent than the spatial overlap pick; the code match won.
          </p>
        {/if}
        {#if codeFallbackCount !== null && codeFallbackCount > 0}
          <p>
            {codeFallbackCount} unit{codeFallbackCount === 1 ? "" : "s"} had no overlapping code
            match and fell back to the spatial pick.
          </p>
        {/if}
        <DownloadMenu
          primaryLabel="Download issues"
          filenameStem={fileStem(childFiles[0])}
          exportSource="match_issues"
        />
      </div>
    {/if}

    {#if resultGeoJSON}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(childFiles[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="match"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      resultGeojson={resultGeoJSON}
      parentOutlineGeojson={parentOutlineGeoJSON}
      bounds={resultBounds}
      processing={running}
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

  .hint {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0.5rem 0 0;
    line-height: 1.4;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .step-heading {
    font-size: 0.9rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }

  .match-cols {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .match-field {
    display: grid;
    grid-template-columns: 70px 1fr;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }

  .match-field select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #fff;
  }

  .passthrough-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .phase-label {
    font-size: 0.85rem;
    color: #374151;
    margin: 0;
    font-weight: 500;
  }

  .group-summary {
    font-size: 0.8rem;
    color: #6b7280;
    margin: 0;
  }

  .groups {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 320px;
    overflow-y: auto;
  }

  .groups > li {
    font-size: 0.8rem;
    color: #6b7280;
  }

  .groups > li.done .group-dot {
    color: #16a34a;
  }

  .groups > li.running .group-dot {
    color: #1d4ed8;
  }

  .groups > li.error .group-dot {
    color: #dc2626;
  }

  .group-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .group-dot {
    width: 12px;
    text-align: center;
    flex-shrink: 0;
    font-weight: 700;
  }

  .group-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-count {
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
  }

  .group-error {
    margin: 0.15rem 0 0 1.1rem;
    font-size: 0.75rem;
    color: #dc2626;
    word-break: break-word;
  }

  .stages {
    list-style: none;
    padding: 0;
    margin: 0.35rem 0 0 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stages li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .stages li.done {
    color: #16a34a;
  }

  .stages li.active {
    color: #1d4ed8;
    font-weight: 500;
  }

  .stage-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
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

  .warn-panel {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.8rem;
    color: #92400e;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .warn-panel p {
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
