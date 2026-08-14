<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { onMount, untrack } from "svelte";
  import IssuesTable from "./IssuesTable.svelte";
  import MapView from "./MapView.svelte";
  import { PipelineError, runDetect, type IssueKind, type IssueRow } from "./pipeline/index";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Load file", "Loading input", "Finding gaps & overlaps", "Assembling issues report"];

  let files = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-4=active stage, 5=done
  let errorStage = $state(0); // stage number that failed, 0=none
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let done = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let issuesGeoJSON = $state<string | null>(null);
  let issues = $state<IssueRow[]>([]);
  let failedKinds = $state<Set<IssueKind>>(new Set());
  let bounds = $state<[number, number, number, number] | null>(null);

  let selectedKey = $state<string | null>(null);
  let focusBbox = $state<[number, number, number, number] | null>(null);

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

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    done = false;
    originalGeoJSON = null;
    issuesGeoJSON = null;
    issues = [];
    failedKinds = new Set();
    bounds = null;
    selectedKey = null;
    focusBbox = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      currentStage = 1;
      stageLabel = "Loading file…";
      await loadFile(duckdbState.db!, duckdbState.conn!, files);

      const result = await runDetect(duckdbState.conn!, (stage, label) => {
        currentStage = stage;
        stageLabel = label;
      });

      originalGeoJSON = result.originalGeoJSON;
      issuesGeoJSON = result.issuesGeoJSON;
      issues = result.issues;
      failedKinds = result.failedKinds;
      bounds = result.bounds;
      currentStage = 5;
      stageLabel = "Done";
      done = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  function selectIssue(key: string): void {
    const row = issues.find((r) => r.key === key);
    if (!row) return;
    selectedKey = key;
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

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }
</script>

<div class="dt-layout">
  <aside class="dt-sidebar">
    <header>
      <a class="dt-back" href={base}>← Topology Tools</a>
      <h1>Detect</h1>
      <p class="dt-blurb">
        Scan a polygon layer for gaps and overlaps and report them — a read-only inspection, not a
        fix. Click any issue to zoom to it.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="dt-error">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="dt-step">
      <DropZone
        bind:files
        disabled={running}
        helpText="Polygon coverage in any supported format — adjacent admin units, basins, etc."
      />

      {#if running || errorStage > 0}
        <ol class="dt-stages">
          {#each STAGE_LABELS as label, i}
            {@const status = stageStatus(i)}
            <li class={status}>
              {#if status === "error"}
                <span class="dt-stage-x">✕</span>
              {:else}
                <span class="dt-stage-dot"></span>
              {/if}
              <span>{i + 1 === currentStage && stageLabel ? stageLabel : label}</span>
            </li>
          {/each}
        </ol>
      {/if}

      {#if error}
        <div class="dt-error">{error}</div>
      {/if}
    </section>

    {#if done}
      <section class="dt-step">
        <h2 class="dt-step-heading">Download</h2>
        <p class="dt-hint">
          Every detected gap and overlap, regardless of size — open in QGIS or ArcGIS to inspect
          them yourself.
        </p>
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={issuesGeoJSON ?? undefined}
          exportSource="detect_issues"
        />
      </section>
    {/if}

    <p class="dt-privacy">Your files never leave your device.</p>
  </aside>

  <div class="dt-result">
    <div class="dt-map-pane">
      <MapView
        originalGeojson={originalGeoJSON}
        issuesGeojson={issuesGeoJSON}
        {bounds}
        {focusBbox}
        {selectedKey}
        processing={running}
        onIssueClick={onMapIssueClick}
      />
    </div>
    {#if done}
      <div class="dt-table-pane">
        <IssuesTable rows={issues} {selectedKey} detectionFailed={failedKinds} onSelect={selectIssue} />
      </div>
    {/if}
  </div>
</div>

<style>
  .dt-layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: 100dvh;
    overflow: hidden;
  }

  .dt-sidebar {
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

  .dt-back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin: 0 0 0.5rem;
  }

  .dt-back:hover {
    color: #111;
  }

  .dt-blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }

  .dt-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .dt-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }

  .dt-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.3;
  }

  .dt-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dt-stages li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #9ca3af;
  }

  .dt-stages li.done {
    color: #16a34a;
  }

  .dt-stages li.active {
    color: #1d4ed8;
    font-weight: 500;
    animation: pulse 1s ease-in-out infinite;
  }

  .dt-stages li.error {
    color: #dc2626;
    font-weight: 500;
  }

  .dt-stage-x {
    width: 8px;
    font-size: 0.75rem;
    line-height: 1;
    flex-shrink: 0;
    text-align: center;
  }

  .dt-stage-dot {
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

  .dt-error {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: #b91c1c;
    word-break: break-word;
  }

  .dt-privacy {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0;
    margin-top: auto;
  }

  .dt-result {
    display: grid;
    grid-template-rows: 60% 40%;
    height: 100dvh;
    min-width: 0;
  }

  .dt-map-pane {
    position: relative;
    min-height: 0;
    border-bottom: 1px solid #e5e7eb;
  }

  .dt-table-pane {
    min-height: 0;
  }

  @media (min-width: 1280px) {
    .dt-result {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr 360px;
    }
    .dt-map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
</style>
