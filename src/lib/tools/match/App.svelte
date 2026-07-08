<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "./MapView.svelte";
  import { runEdgeMatch, type EdgeMatchPhase } from "./pipeline/index";
  import type { GroupResult } from "./pipeline/groups";

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
  let method = $state<"exact" | "sampling" | null>(null);
  let unassignedCount = $state<number | null>(null);

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
        if (!running) handleRun();
      });
    }
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
    method = null;
    unassignedCount = null;
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
      );
      resultGeoJSON = result.geojson;
      parentOutlineGeoJSON = result.parentOutlineGeojson;
      resultBounds = result.bounds;
      method = result.method;
      unassignedCount = result.unassignedCount;
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
      <a class="back" href="/">← Topology Tools</a>
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
        helpText="The boundary to match and clip against — one level up or many."
      />
    </section>

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

    {#if unassignedCount !== null && unassignedCount > 0}
      <div class="warn-panel">
        {unassignedCount} fine unit{unassignedCount === 1 ? "" : "s"} had no overlap with any
        coarse polygon and {unassignedCount === 1 ? "was" : "were"} excluded from the result.
        <DownloadMenu
          primaryLabel="Download unassigned"
          filenameStem={fileStem(childFiles[0])}
          exportSource="match_unassigned"
        />
      </div>
    {/if}

    {#if resultGeoJSON}
      <section class="step">
        {#if method === "sampling"}
          <p class="method-note">Overlap measured by point sampling (fallback).</p>
        {/if}
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

  .method-note {
    font-size: 0.75rem;
    color: #9ca3af;
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
