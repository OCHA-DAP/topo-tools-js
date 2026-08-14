<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { PipelineError, runStitch, type StitchIssueRow } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Load file", "Loading input", "Closing seams", "Checking for residual gaps"];

  let files = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-4=active stage, 5=done
  let errorStage = $state(0); // stage number that failed, 0=none
  let stageLabel = $state("");
  let resultGeoJSON = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let issues = $state<StitchIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);
  let hadResidualOverlaps = $state(false);
  let error = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const f = files;
    if (f.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (!running) handleRun();
      });
    }
  });

  async function handleRun() {
    clearMap?.();
    error = null;
    running = true;
    resultGeoJSON = null;
    originalGeoJSON = null;
    resultBounds = null;
    issues = [];
    issuesGeoJSON = null;
    hadResidualOverlaps = false;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      currentStage = 1;
      stageLabel = "Loading file…";
      await loadFile(duckdbState.db!, duckdbState.conn!, files);

      const result = await runStitch(duckdbState.conn!, (stage, label) => {
        currentStage = stage;
        stageLabel = label;
      });

      resultGeoJSON = result.stitchedGeoJSON;
      originalGeoJSON = result.originalGeoJSON;
      resultBounds = result.bounds;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      hadResidualOverlaps = result.hadResidualOverlaps;
      currentStage = 5;
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
    if (currentStage === 5) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Stitch</h1>
      <p class="blurb">
        Close seams in an already-tiled polygon layer — for example tiles produced independently by
        Edge Extender or Edge Matcher — with one whole-table coverage-clean pass.
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
        disabled={running}
        helpText="Already-tiled polygon layer in WGS84. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />

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

      {#if hadResidualOverlaps}
        <div class="warn-panel">
          Some overlaps remain after cleaning — this shouldn't normally happen. Inspect the output
          before relying on it.
        </div>
      {/if}

      {#if resultGeoJSON}
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="stitch"
        />
      {/if}

      {#if resultGeoJSON && issues.length > 0}
        <div class="issues-note">
          {issues.length} gap{issues.length === 1 ? "" : "s"} wider than the noise floor
          {issues.length === 1 ? "remains" : "remain"} — may be a legitimate unfilled gap, not a
          defect.
        </div>
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={issuesGeoJSON ?? undefined}
          exportSource="stitch_issues"
          variant="secondary"
        />
      {/if}
    </section>

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON}
      bounds={resultBounds}
      processing={running}
      registerClear={(fn: () => void) => { clearMap = fn; }}
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

  .stages li.active {
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
    font-size: 0.825rem;
    color: #92400e;
  }

  .issues-note {
    font-size: 0.8rem;
    color: #6b7280;
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
