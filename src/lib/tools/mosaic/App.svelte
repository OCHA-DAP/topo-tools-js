<script lang="ts">
  import CarryColumnsPicker from "$lib/components/CarryColumnsPicker.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { onMount, untrack } from "svelte";
  import { PipelineError, runMosaic, type MosaicIssueRow } from "./pipeline/index";
  import type { ColumnGuess } from "$lib/db/columns";
  import type { ApplyFillOptions } from "$lib/db/fillCompose";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Loading input",
    "Assigning to overlay feature",
    "Clipping to overlay boundary",
    "Closing seams",
    "Checking for residual gaps",
    "Assembling issues report",
  ];

  let inputFiles = $state<File[]>([]);
  let overlayFiles = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-6=active stage, 7=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let resultGeoJSON = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let overlayOutlineGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let overlayFid = $state<number | null>(null);
  let issues = $state<MosaicIssueRow[]>([]);
  let issuesGeoJSON = $state<string | null>(null);
  let hadResidualOverlaps = $state(false);

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior.
  let inputColumns = $state<ColumnGuess | null>(null);
  let overlayColumns = $state<ColumnGuess | null>(null);
  let inputMatchColumn = $state<string | null>(null);
  let overlayMatchColumn = $state<string | null>(null);
  let carryOverlayColumns = $state<string[]>([]);

  let fillSchema = $state(false);
  let fillNameField = $state("");
  let fillCodeField = $state("");
  let fillDepthColumn = $state("adm_lvl");

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  const fillOneBlank = $derived((fillNameField.trim() === "") !== (fillCodeField.trim() === ""));
  const fillBothBlank = $derived(fillNameField.trim() === "" && fillCodeField.trim() === "");
  const fillTemplateValid = $derived(
    !fillOneBlank && (fillBothBlank || (fillNameField.includes("{n}") && fillCodeField.includes("{n}"))),
  );

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

  // Re-run picks up a schema-fill option change on already-produced output;
  // holds off while the template pair is mid-edit (one side blank).
  $effect(() => {
    const _s = fillSchema;
    const _n = fillNameField;
    const _c = fillCodeField;
    const _d = fillDepthColumn;
    untrack(() => {
      if (!resultGeoJSON || running || !fillTemplateValid) return;
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
    overlayFid = null;
    issues = [];
    issuesGeoJSON = null;
    hadResidualOverlaps = false;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      const fillOptions: ApplyFillOptions | undefined = fillSchema
        ? {
            requested: true,
            nameField: fillBothBlank ? null : fillNameField,
            codeField: fillBothBlank ? null : fillCodeField,
            depthColumn: fillDepthColumn,
          }
        : undefined;

      const result = await runMosaic(
        duckdbState.db!,
        duckdbState.conn!,
        inputFiles,
        overlayFiles,
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
        { overlayMatchColumn: overlayMatchColumn ?? undefined, inputMatchColumn: inputMatchColumn ?? undefined },
        carryOverlayColumns,
        fillOptions,
      );

      resultGeoJSON = result.mosaicGeoJSON;
      originalGeoJSON = result.inputGeoJSON;
      overlayOutlineGeoJSON = result.overlayOutlineGeoJSON;
      resultBounds = result.bounds;
      overlayFid = result.overlayFid;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      hadResidualOverlaps = result.hadResidualOverlaps;
      inputColumns = result.inputColumns;
      overlayColumns = result.overlayColumns;
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

  const clipEmptyCount = $derived(issues.filter((i) => i.kind === "clip-empty").length);
  const gapCount = $derived(issues.filter((i) => i.kind === "gap").length);
  const microCount = $derived(issues.filter((i) => i.kind === "micro-polygon").length);
  const codeMismatchCount = $derived(issues.filter((i) => i.kind === "code-mismatch").length);
  const codeFallbackCount = $derived(issues.filter((i) => i.kind === "code-fallback").length);
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>← Topology Tools</a>
      <h1>Mosaic</h1>
      <p class="blurb">
        Fit an already-extended input layer into a new overlay feature boundary without re-running
        Voronoi extension: assign by majority vote, clip to the winning overlay feature, then close seams
        with a single coverage-clean pass. For inputs that haven't been extended yet, use Edge
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
      <h2 class="step-heading">Input layer</h2>
      <DropZone
        bind:files={inputFiles}
        urlParam="input"
        disabled={running}
        helpText="An already-extended layer — e.g. one country's Edge Extender output."
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

    {#if inputColumns && overlayColumns}
      <section class="step">
        <h2 class="step-heading">Code join (optional)</h2>
        <p class="hint">
          Wins over the majority-vote overlay feature wherever the codes agree on an overlay feature the file
          overlaps at all, falls back to the majority vote when no code match exists.
        </p>
        <div class="match-cols">
          <label class="match-field">
            <span>Input code</span>
            <select bind:value={inputMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each inputColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
          <label class="match-field">
            <span>Overlay code</span>
            <select bind:value={overlayMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each overlayColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
        </div>
      </section>
    {/if}

    {#if overlayColumns}
      <section class="step">
        <h2 class="step-heading">Carry overlay columns (optional)</h2>
        <p class="hint">
          Join the winning overlay feature's own attribute values onto every output row. A column the input layer
          already has can't be carried.
        </p>
        <CarryColumnsPicker
          overlayColumns={overlayColumns.all}
          inputColumns={inputColumns?.all ?? []}
          bind:selected={carryOverlayColumns}
          disabled={running}
        />
      </section>
    {/if}

    <section class="step">
      <h2 class="step-heading">Schema fill (optional)</h2>
      <label class="checkbox-field">
        <input type="checkbox" bind:checked={fillSchema} disabled={running} />
        <span>Cascade admin-hierarchy columns down before export</span>
      </label>
      {#if fillSchema}
        <p class="hint">Leave both templates blank to auto-detect the hierarchy structurally.</p>
        <label class="field">
          <span>Name template</span>
          <input
            type="text"
            bind:value={fillNameField}
            placeholder="auto-detect"
            disabled={running}
          />
        </label>
        <label class="field">
          <span>Code template</span>
          <input
            type="text"
            bind:value={fillCodeField}
            placeholder="auto-detect"
            disabled={running}
          />
        </label>
        <label class="field">
          <span>Depth column</span>
          <input type="text" bind:value={fillDepthColumn} disabled={running} />
        </label>
        {#if fillOneBlank}
          <p class="field-error">Both templates must be set, or both left blank to auto-detect.</p>
        {:else if !fillBothBlank && !fillTemplateValid}
          <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
        {/if}
      {/if}
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

    {#if resultGeoJSON && overlayFid !== null}
      <section class="step">
        <p class="info-line">Fitted to overlay feature fid {overlayFid}.</p>
        {#if clipEmptyCount > 0}
          <p class="warn-line">
            {clipEmptyCount} input feature{clipEmptyCount === 1 ? " falls" : "s fall"} outside it and
            {clipEmptyCount === 1 ? "was" : "were"} clipped away, see the issues download.
          </p>
        {/if}
        {#if gapCount > 0}
          <p class="warn-line">
            {gapCount} gap{gapCount === 1 ? "" : "s"} remaining, see the issues download.
          </p>
        {/if}
        {#if microCount > 0}
          <p class="warn-line">
            {microCount} micro-polygon{microCount === 1 ? "" : "s"} (narrower than the snap tolerance) merged
            into a neighbouring feature or dropped.
          </p>
        {/if}
        {#if hadResidualOverlaps}
          <p class="warn-line">Overlaps remain after seam-closing, see the issues download.</p>
        {/if}
        {#if codeMismatchCount > 0}
          <p class="warn-line">
            Code match disagreed with the majority-vote overlay feature for {codeMismatchCount} input feature{codeMismatchCount ===
             1
              ? ""
              : "s"}; the code match won.
          </p>
        {/if}
        {#if codeFallbackCount > 0}
          <p class="warn-line">
            No overlapping code match for {codeFallbackCount} input feature{codeFallbackCount === 1 ? "" : "s"};
            fell back to the majority-vote overlay.
          </p>
        {/if}
      </section>
    {/if}

    {#if resultGeoJSON}
      <DownloadMenu
        primaryLabel="Download GeoJSON"
        filenameStem={fileStem(inputFiles[0])}
        cachedGeoJSON={resultGeoJSON}
        exportSource="mosaic"
      />
      {#if issues.length > 0 && issuesGeoJSON}
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(inputFiles[0])}
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
      originalGeojson={originalGeoJSON ?? overlayOutlineGeoJSON}
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

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .field input {
    padding: 0.4rem 0.55rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .field-error {
    font-size: 0.75rem;
    color: #b91c1c;
    margin: 0;
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
