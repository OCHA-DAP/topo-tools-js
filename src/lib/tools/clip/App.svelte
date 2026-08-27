<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import { PipelineError, runClip, type ClipIssueRow } from "./pipeline/index";
  import type { ColumnGuess } from "$lib/db/columns";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = ["Loading input", "Assigning to parent unit", "Clipping to parent boundary"];

  let childFiles = $state<File[]>([]);
  let parentFiles = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-3=active stage, 4=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let resultGeoJSON = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let parentOutlineGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let parentFid = $state<number | null>(null);
  let assignedCount = $state(0);
  let droppedAssignCount = $state(0);
  let emptyClipCount = $state(0);
  let issues = $state<ClipIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior.
  let childColumns = $state<ColumnGuess | null>(null);
  let parentColumns = $state<ColumnGuess | null>(null);
  let childMatchColumn = $state<string | null>(null);
  let parentMatchColumn = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const c = childFiles;
    const p = parentFiles;
    if (c.length > 0 && p.length > 0 && duckdbState.ready) {
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

  $effect(() => {
    const _c = childMatchColumn;
    const _p = parentMatchColumn;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      if ((childMatchColumn == null) !== (parentMatchColumn == null)) return;
      handleRun();
    });
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
    assignedCount = 0;
    droppedAssignCount = 0;
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
        childFiles,
        parentFiles,
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
        { parentMatchColumn: parentMatchColumn ?? undefined, childMatchColumn: childMatchColumn ?? undefined },
      );

      resultGeoJSON = result.clippedGeoJSON;
      originalGeoJSON = result.childGeoJSON;
      parentOutlineGeoJSON = result.parentOutlineGeoJSON;
      resultBounds = result.bounds;
      parentFid = result.parentFid;
      assignedCount = result.assignedCount;
      droppedAssignCount = result.droppedAssignCount;
      emptyClipCount = result.emptyClipCount;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      childColumns = result.childColumns;
      parentColumns = result.parentColumns;
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

  const codeMismatchCount = $derived(issues.filter((i) => i.kind === "code-mismatch").length);
  const codeFallbackCount = $derived(issues.filter((i) => i.kind === "code-fallback").length);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Clip</h1>
      <p class="blurb">
        Force a children layer onto the one parent unit it overlaps most (by majority vote across
        every child), then clip every child to exactly that parent's boundary. Built for
        already-extended, overshooting geometry — e.g. one country's units after Edge Extender —
        where a per-child assignment could be fooled by border overshoot.
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
        helpText="The layer to assign and clip — one already-extended file's worth of units."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Parent / clip layer</h2>
      <DropZone
        bind:files={parentFiles}
        disabled={running}
        helpText="The boundary to assign and clip against, e.g. admin0 for an admin2/3 children layer."
      />
    </section>

    {#if childColumns && parentColumns}
      <section class="step">
        <h2 class="step-heading">Code join (optional)</h2>
        <p class="hint">
          Wins over the majority-vote parent wherever the codes agree on a parent the file
          overlaps at all, falls back to the majority vote when no code match exists.
        </p>
        <div class="match-cols">
          <label class="match-field">
            <span>Child code</span>
            <select bind:value={childMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each childColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
          <label class="match-field">
            <span>Parent code</span>
            <select bind:value={parentMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each parentColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
        </div>
      </section>
    {/if}

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
        <p class="info-line">Assigned to parent unit fid {parentFid} — {assignedCount} of {assignedCount + droppedAssignCount} children agreed.</p>
        {#if droppedAssignCount > 0}
          <p class="warn-line">
            {droppedAssignCount} child{droppedAssignCount === 1 ? "" : "ren"} dropped — didn't overlap
            the winning parent unit.
          </p>
        {/if}
        {#if emptyClipCount > 0}
          <p class="warn-line">
            {emptyClipCount} more dropped, clipped to an empty result.
          </p>
        {/if}
        {#if codeMismatchCount > 0}
          <p class="warn-line">
            Code match disagreed with the majority-vote parent for {codeMismatchCount} child{codeMismatchCount ===
            1
              ? ""
              : "ren"}; the code match won.
          </p>
        {/if}
        {#if codeFallbackCount > 0}
          <p class="warn-line">
            No overlapping code match for {codeFallbackCount} child{codeFallbackCount === 1 ? "" : "ren"};
            fell back to the majority-vote parent.
          </p>
        {/if}
      </section>
    {/if}

    {#if resultGeoJSON}
      <DownloadMenu
        primaryLabel="Download GeoJSON"
        filenameStem={fileStem(childFiles[0])}
        cachedGeoJSON={resultGeoJSON}
        exportSource="clip"
      />
      {#if issues.length > 0 && issuesGeoJSON}
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(childFiles[0])}
          cachedGeoJSON={issuesGeoJSON}
          exportSource="clip_issues"
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

  .hint {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0;
    line-height: 1.4;
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
