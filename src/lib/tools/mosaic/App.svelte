<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import { PipelineError, runMosaic, type MosaicIssueRow } from "./pipeline/index";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Loading input",
    "Assigning to parent unit",
    "Clipping to parent boundary",
    "Closing seams",
    "Checking for residual gaps",
    "Assembling issues report",
  ];

  let childFiles = $state<File[]>([]);
  let parentFiles = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-6=active stage, 7=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let resultGeoJSON = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let parentOutlineGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let parentFid = $state<number | null>(null);
  let issues = $state<MosaicIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);
  let hadResidualOverlaps = $state(false);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const c = childFiles;
    const p = parentFiles;
    if (c.length > 0 && p.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (!running) handleRun();
      });
    }
  });

  async function handleRun(): Promise<void> {
    clearMap?.();
    error = null;
    running = true;
    resultGeoJSON = null;
    originalGeoJSON = null;
    parentOutlineGeoJSON = null;
    resultBounds = null;
    parentFid = null;
    issues = [];
    issuesGeoJSON = null;
    hadResidualOverlaps = false;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      const result = await runMosaic(
        duckdbState.db!,
        duckdbState.conn!,
        childFiles,
        parentFiles,
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
      );

      resultGeoJSON = result.mosaicGeoJSON;
      originalGeoJSON = result.childGeoJSON;
      parentOutlineGeoJSON = result.parentOutlineGeoJSON;
      resultBounds = result.bounds;
      parentFid = result.parentFid;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      hadResidualOverlaps = result.hadResidualOverlaps;
      currentStage = 7;
      stageLabel = "Done";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

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

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const unassignedCount = $derived(issues.filter((i) => i.kind === "unassigned").length);
  const gapCount = $derived(issues.filter((i) => i.kind === "gap").length);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Mosaic</h1>
      <p class="blurb">
        Fit an already-extended children layer into a new parent boundary without re-running
        Voronoi extension: assign by majority vote, clip to the winning parent, then close seams
        with a single coverage-clean pass. For children that haven't been extended yet, use Edge
        Matcher instead.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <h2 class="step-heading">Children layer</h2>
      <DropZone
        bind:files={childFiles}
        disabled={running}
        helpText="An already-extended layer — e.g. one country's Edge Extender output."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Parent / clip layer</h2>
      <DropZone
        bind:files={parentFiles}
        disabled={running}
        helpText="The boundary to assign and clip against — e.g. admin0 for an admin2/3 children layer."
      />
    </section>

    {#if running || errorStage > 0}
      <ol class="stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}
              <span class="stage-x">✕</span>
            {:else}
              <span class="stage-dot"></span>
            {/if}
            <span class="stage-label"
              >{i + 1 === currentStage && stageLabel ? stageLabel : label}</span
            >
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if resultGeoJSON && parentFid !== null}
      <section class="step">
        <p class="info-line">Fitted to parent unit fid {parentFid}.</p>
        {#if unassignedCount > 0 || gapCount > 0}
          <p class="warn-line">
            {unassignedCount} child{unassignedCount === 1 ? "" : "ren"} unassigned, {gapCount} gap{gapCount ===
            1
              ? ""
              : "s"} remaining — see the issues download.
          </p>
        {/if}
        {#if hadResidualOverlaps}
          <p class="warn-line">Overlaps remain after seam-closing — see the issues download.</p>
        {/if}
      </section>
    {/if}

    {#if resultGeoJSON}
      <DownloadMenu
        primaryLabel="Download GeoJSON"
        filenameStem={fileStem(childFiles[0])}
        cachedGeoJSON={resultGeoJSON}
        exportSource="mosaic"
      />
      {#if issues.length > 0 && issuesGeoJSON}
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(childFiles[0])}
          cachedGeoJSON={issuesGeoJSON}
          exportSource="mosaic_issues"
          variant="secondary"
        />
      {/if}
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON ?? parentOutlineGeoJSON}
      bounds={resultBounds}
      processing={running}
      registerClear={(fn: () => void) => {
        clearMap = fn;
      }}
    />
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
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
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }

  .stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stages li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #9ca3af;
  }

  .stages li.done {
    color: #16a34a;
  }

  .stages li.active {
    color: #1d4ed8;
    font-weight: 500;
    animation: pulse 1s ease-in-out infinite;
  }

  .stages li.error {
    color: #dc2626;
    font-weight: 500;
  }

  .stage-x {
    width: 8px;
    font-size: 0.75rem;
    line-height: 1;
    flex-shrink: 0;
    text-align: center;
  }

  .stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
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

  .info-line {
    font-size: 0.8rem;
    color: #374151;
    margin: 0;
    line-height: 1.4;
  }

  .warn-line {
    font-size: 0.8rem;
    color: #92400e;
    margin: 0;
    line-height: 1.4;
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
