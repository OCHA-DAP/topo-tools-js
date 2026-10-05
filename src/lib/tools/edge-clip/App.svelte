<script lang="ts">
  import CarryColumnsPicker from "$lib/components/CarryColumnsPicker.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import CleanupNote from "$lib/components/CleanupNote.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import CodeJoinPicker from "$lib/components/CodeJoinPicker.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import { PipelineError, runClip, type ClipIssueRow } from "./pipeline/index";
  import type { ColumnGuess } from "$lib/db/columns";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Loading input", "Assigning to overlay polygon", "Clipping to overlay boundary"];

  let inputFiles = $state<File[]>([]);
  let overlayFiles = $state<File[]>([]);
  let originalFiles = $state<File[]>([]);
  let advancedOpen = $state(false);
  $effect(() => {
    if (originalFiles.length > 0) advancedOpen = true;
  });
  let detachedMerged = $state(0);
  let detachedKept = $state(0);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-3=active stage, 4=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let resultGeoJSON = $state<string | null>(null);
  let showSide = $state<"a" | "b">("b");
  let originalGeoJSON = $state<string | null>(null);
  let overlayOutlineGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let overlayFid = $state<number | null>(null);
  let assignedCount = $state(0);
  let overlappingCount = $state(0);
  let emptyClipCount = $state(0);
  let issues = $state<ClipIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior.
  let inputColumns = $state<ColumnGuess | null>(null);
  let overlayColumns = $state<ColumnGuess | null>(null);
  let inputMatchColumn = $state<string | null>(null);
  let overlayMatchColumn = $state<string | null>(null);
  let carryOverlayColumns = $state<string[]>([]);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const c = inputFiles;
    const p = overlayFiles;
    if (c.length > 0 && p.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (running) return;
        inputColumns = null;
        overlayColumns = null;
        inputMatchColumn = null;
        overlayMatchColumn = null;
        carryOverlayColumns = [];
        handleRun();
      });
    }
  });

  $effect(() => {
    const _c = inputMatchColumn;
    const _p = overlayMatchColumn;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      if ((inputMatchColumn == null) !== (overlayMatchColumn == null)) return;
      handleRun();
    });
  });

  $effect(() => {
    const _cols = carryOverlayColumns;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      handleRun();
    });
  });

  $effect(() => {
    const _o = originalFiles;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      handleRun();
    });
  });

  async function handleRun(): Promise<void> {
    clearMap?.();
    error = null;
    running = true;
    resultGeoJSON = null;
    originalGeoJSON = null;
    overlayOutlineGeoJSON = null;
    resultBounds = null;
    detachedMerged = 0;
    detachedKept = 0;
    overlayFid = null;
    assignedCount = 0;
    overlappingCount = 0;
    emptyClipCount = 0;
    issues = [];
    issuesGeoJSON = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      const result = await runClip(
        duckdbState.db!,
        duckdbState.conn!,
        inputFiles,
        overlayFiles,
        originalFiles,
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
        { overlayMatchColumn: overlayMatchColumn ?? undefined, inputMatchColumn: inputMatchColumn ?? undefined },
        carryOverlayColumns,
      );

      resultGeoJSON = result.clippedGeoJSON;
      showSide = "b";
      originalGeoJSON = result.inputGeoJSON;
      overlayOutlineGeoJSON = result.overlayOutlineGeoJSON;
      resultBounds = result.bounds;
      detachedMerged = result.detachedMergedCount;
      detachedKept = result.detachedKeptCount;
      overlayFid = result.overlayFid;
      assignedCount = result.assignedCount;
      overlappingCount = result.overlappingCount;
      emptyClipCount = result.emptyClipCount;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      inputColumns = result.inputColumns;
      overlayColumns = result.overlayColumns;
      currentStage = 4;
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
    if (currentStage === 4) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const microCount = $derived(issues.filter((i) => i.kind === "micro-polygon").length);
  const codeMismatchCount = $derived(issues.filter((i) => i.kind === "code-mismatch").length);
  const codeFallbackCount = $derived(issues.filter((i) => i.kind === "code-fallback").length);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Clip</h1>
      <p class="blurb">
        Force an input layer onto the one overlay polygon it overlaps most (by majority vote across
        every input), then clip every input to exactly that overlay's boundary. Built for
        already-extended, overshooting geometry — e.g. one country's units after Edge Extender —
        where a per-input assignment could be fooled by border overshoot.
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
        disabled={running}
        helpText="The layer to assign and clip — one already-extended file's worth of units."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Overlay layer</h2>
      <DropZone
        bind:files={overlayFiles}
        urlParam="overlay"
        disabled={running}
        helpText="The boundary to assign and clip against, e.g. admin0 for an admin2/3 input layer."
      />
    </section>

    <AdvancedOptions bind:open={advancedOpen}>
      <div>
        <h3>Original layer</h3>
        <DropZone
          bind:files={originalFiles}
          urlParam="original"
          disabled={running}
          helpText="The input before Edge Extender. Small pieces the clip cuts off a unit merge into their longest-edge neighbour only where this layer doesn't draw them as part of the unit."
        />
      </div>
      {#if inputColumns && overlayColumns}
        <CodeJoinPicker
          inputColumns={inputColumns.all}
          overlayColumns={overlayColumns.all}
          bind:inputValue={inputMatchColumn}
          bind:overlayValue={overlayMatchColumn}
          hint="Pick the overlay polygon by a shared code column where the codes agree, falling back to overlap where they don't."
          disabled={running}
        />
      {/if}
      {#if overlayColumns}
        <div>
          <h3>Carry overlay columns</h3>
          <p class="hint">
            Copy the overlay polygon's own values onto every output row. A column the input layer already has
            can't be carried.
          </p>
          <CarryColumnsPicker
            overlayColumns={overlayColumns.all}
            inputColumns={inputColumns?.all ?? []}
            bind:selected={carryOverlayColumns}
            disabled={running}
          />
        </div>
      {/if}
    </AdvancedOptions>

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

    {#if resultGeoJSON && overlayFid !== null}
      <section class="step">
        <p class="info-line">
          Fitted to overlay polygon fid {overlayFid}, which {overlappingCount} of {assignedCount} input
          polygons overlap.
        </p>
        {#if emptyClipCount > 0}
          <p class="warn-line">
            {emptyClipCount} input polygon{emptyClipCount === 1 ? " falls" : "s fall"} outside it and
            {emptyClipCount === 1 ? "was" : "were"} clipped away, see the issues download.
          </p>
        {/if}
        {#if microCount + detachedMerged + detachedKept > 0}
          <p class="info-line"><CleanupNote count={microCount + detachedMerged + detachedKept} /></p>
        {/if}
        {#if codeMismatchCount > 0}
          <p class="warn-line">
            {codeMismatchCount} input polygon{codeMismatchCount === 1 ? " was" : "s were"} matched by code to a
            different overlay polygon than overlap alone would pick.
          </p>
        {/if}
        {#if codeFallbackCount > 0}
          <p class="warn-line">
            {codeFallbackCount} input polygon{codeFallbackCount === 1 ? "" : "s"} had no matching code and
            {codeFallbackCount === 1 ? "was" : "were"} matched by overlap.
          </p>
        {/if}
      </section>
    {/if}

    {#if resultGeoJSON}
      <DownloadMenu
        primaryLabel="Download GeoJSON"
        filenameStem={fileStem(inputFiles[0])}
        cachedGeoJSON={resultGeoJSON}
        exportSource="clip"
      />
      {#if issues.length > 0 && issuesGeoJSON}
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(inputFiles[0])}
          cachedGeoJSON={issuesGeoJSON}
          exportSource="clip_issues"
          variant="secondary"
        />
      {/if}
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    {#if resultGeoJSON}
      <SideToggle bind:side={showSide} labels={["Original", "Clipped"]} disabled={running} />
    {/if}
    <MapView
      showSide={resultGeoJSON ? showSide : undefined}
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON}
      overlayOutlineGeojson={overlayOutlineGeoJSON}
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

  .hint {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    line-height: 1.4;
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

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
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
    color: var(--hdx-neutral-5);
  }

  .stages li.done {
    color: var(--hdx-success-5);
  }

  .stages li.active {
    color: var(--hdx-primary-5);
    font-weight: 500;
    animation: pulse 1s ease-in-out infinite;
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

  .info-line {
    font-size: 0.8rem;
    color: var(--hdx-neutral-8);
    margin: 0;
    line-height: 1.4;
  }

  .warn-line {
    font-size: 0.8rem;
    color: var(--hdx-warning-7);
    margin: 0;
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
