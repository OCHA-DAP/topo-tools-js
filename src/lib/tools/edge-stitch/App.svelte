<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { PipelineError, runStitch, type StitchIssueRow } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import CleanupNote from "$lib/components/CleanupNote.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Load file", "Loading input", "Closing seams", "Checking for residual gaps"];

  let files = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-4=active stage, 5=done
  let errorStage = $state(0); // stage number that failed, 0=none
  let stageLabel = $state("");
  let resultGeoJSON = $state<string | null>(null);
  let showSide = $state<"a" | "b">("b");
  let originalGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let issues = $state<StitchIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);
  const gapCount = $derived(issues.filter((i) => i.kind === "gap").length);
  const microCount = $derived(issues.filter((i) => i.kind === "micro-polygon").length);
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

      const result = await runStitch(
        duckdbState.conn!,
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
        undefined,
        undefined,
      );

      resultGeoJSON = result.stitchedGeoJSON;
      showSide = "b";
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
        urlParam="url"
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
    </section>

    <section class="step">
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
        {#if gapCount > 0}
          <div class="issues-note">
            {gapCount} gap{gapCount === 1 ? " remains" : "s remain"} in the result. Some may be real gaps
            in the data rather than defects.
          </div>
        {/if}
        {#if microCount > 0}
          <div class="issues-note">
            <CleanupNote count={microCount} />
          </div>
        {/if}
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
    {#if resultGeoJSON}
      <SideToggle bind:side={showSide} labels={["Original", "Stitched"]} disabled={running} />
    {/if}
    <MapView
      showSide={resultGeoJSON ? showSide : undefined}
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
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--hdx-neutral-1);
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
    color: var(--hdx-neutral-5);
  }

  .stages li.done {
    color: var(--hdx-success-5);
  }

  .stages li.active {
    color: var(--hdx-primary-5);
    font-weight: 500;
  }

  .stages li.error {
    color: var(--hdx-error-5);
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
    background: var(--hdx-error-05);
    border: 1px solid var(--hdx-error-3);
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--hdx-error-6);
    word-break: break-word;
  }

  .warn-panel {
    background: var(--hdx-warning-05);
    border: 1px solid var(--hdx-warning-2);
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--hdx-warning-7);
  }

  .issues-note {
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
    line-height: 1.4;
  }






  .privacy {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    margin-top: auto;
  }

  .map-container {
    position: relative;
    height: 100%;
    overflow: hidden;
  }
</style>
