<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { boolParam, choiceParam, textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { onMount, untrack } from "svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "./MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";
  import { runEdgeMatch, type EdgeMatchPhase } from "./pipeline/index";
  import type { GroupResult } from "./pipeline/groups";
  import type { ColumnGuess } from "$lib/db/columns";
  import type { ApplyFillOptions } from "$lib/db/fillCompose";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Load file",
    "Extract boundary lines",
    "Interpolate points",
    "Build Voronoi diagram",
    "Merge polygons",
  ];

  type GroupRow = GroupResult | { overlayFid: number; label: string; inputCount: number; status: "pending" | "running" };

  let inputFiles = $state<File[]>([]);
  let overlayFiles = $state<File[]>([]);
  let running = $state(false);
  let phaseLabel = $state("");
  let error = $state<string | null>(null);

  let groupRows = $state<GroupRow[]>([]);
  let activeGroupIndex = $state(-1);
  let activeStage = $state(0);

  let resultGeoJSON = $state<string | null>(null);
  let overlayOutlineGeoJSON = $state<string | null>(null);
  let inputGeoJSON = $state<string | null>(null);
  let streamGeoJSON = $state<string | null>(null);
  let activeOverlayFid = $state<number | null>(null);
  let replacedGroupIds = $state<number[]>([]);
  let showSide = $state<"a" | "b">("b");
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let unassignedCount = $state<number | null>(null);
  let droppedCount = $state<number | null>(null);
  let passthroughCount = $state<number | null>(null);
  let codeMismatchCount = $state<number | null>(null);
  let codeFallbackCount = $state<number | null>(null);
  let microCount = $state<number | null>(null);
  let gapCount = $state<number | null>(null);
  let clipEmptyCount = $state<number | null>(null);
  let assignedOverlayLabel = $state<string | null>(null);
  let passthrough = $state(false);
  let perFeature = $state(false);

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior, even when a plausible code column
  // exists. Repicking after a run reruns the whole pipeline, since a
  // reassigned input feature can move to a different group entirely.
  let inputColumns = $state<ColumnGuess | null>(null);
  let overlayColumns = $state<ColumnGuess | null>(null);
  let inputMatchColumn = $state<string | null>(null);
  let overlayMatchColumn = $state<string | null>(null);

  let fillSchema = $state(false);
  let fillNameField = $state("");
  let fillCodeField = $state("");
  let fillDepthColumn = $state("adm_lvl");
  syncParam(
    "fit",
    choiceParam(["all", "each"] as const),
    () => (perFeature ? "each" : "all"),
    (v) => (perFeature = v === "each"),
  );
  syncParam("passthrough", boolParam, () => passthrough, (v) => (passthrough = v));
  syncParam("fill", boolParam, () => fillSchema, (v) => (fillSchema = v));
  syncParam("name", textParam, () => fillNameField, (v) => (fillNameField = v));
  syncParam("code", textParam, () => fillCodeField, (v) => (fillCodeField = v));
  syncParam("depth", textParam, () => fillDepthColumn, (v) => (fillDepthColumn = v));

  onMount(() => {
    initDuckDB();
  });

  const fillOneBlank = $derived((fillNameField.trim() === "") !== (fillCodeField.trim() === ""));
  const fillBothBlank = $derived(fillNameField.trim() === "" && fillCodeField.trim() === "");
  const fillTemplateValid = $derived(
    !fillOneBlank && (fillBothBlank || (fillNameField.includes("{n}") && fillCodeField.includes("{n}"))),
  );

  $effect(() => {
    if (duckdbState.ready) {
      // @ts-expect-error temporary debug hook, removed after manual QA
      window.__dbg = { conn: duckdbState.conn, db: duckdbState.db };
    }
  });

  $effect(() => {
    const f = inputFiles;
    const c = overlayFiles;
    if (f.length > 0 && c.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (running) return;
        inputColumns = null;
        overlayColumns = null;
        inputMatchColumn = null;
        overlayMatchColumn = null;
        handleRun();
      });
    }
  });

  // Repicking the code-join column after the first run reruns the whole
  // pipeline: a reassigned input feature can move to a different group entirely, so
  // there is no cheaper partial-recompute path here (unlike Changelog's).
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
    const _p = passthrough;
    const _f = perFeature;
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

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  // Finished groups' features, flushed to the map at most every 500 ms.
  let streamFeatures: unknown[] = [];
  let streamGroupIds: number[] = [];
  let streamTimer: ReturnType<typeof setTimeout> | undefined;

  // Swaps a group's input for its result in the same flush, so neither shows alone.
  function flushStream(): void {
    streamTimer = undefined;
    streamGeoJSON = JSON.stringify({ type: "FeatureCollection", features: streamFeatures });
    replacedGroupIds = [...streamGroupIds];
  }

  function resetStream(): void {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    streamFeatures = [];
    streamGroupIds = [];
    streamGeoJSON = null;
    replacedGroupIds = [];
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
        overlayOutlineGeoJSON = event.overlayOutlineGeojson;
        inputGeoJSON = event.inputGeojson;
        resultBounds = event.bounds;
        break;
      case "group-stage":
        activeGroupIndex = event.groupIndex;
        activeStage = event.stage;
        activeOverlayFid = event.group.overlayFid;
        groupRows[event.groupIndex] = { ...event.group, status: "running" };
        break;
      case "group-done":
        groupRows[event.groupIndex] = event.result;
        if (event.result.geojson) {
          streamFeatures.push(...JSON.parse(event.result.geojson).features);
          streamGroupIds.push(event.result.overlayFid);
          streamTimer ??= setTimeout(flushStream, 500);
        }
        if (activeGroupIndex === event.groupIndex) activeStage = 0;
        break;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resultGeoJSON = null;
    overlayOutlineGeoJSON = null;
    inputGeoJSON = null;
    activeOverlayFid = null;
    resetStream();
    resultBounds = null;
    unassignedCount = null;
    droppedCount = null;
    passthroughCount = null;
    codeMismatchCount = null;
    codeFallbackCount = null;
    microCount = null;
    gapCount = null;
    clipEmptyCount = null;
    assignedOverlayLabel = null;
    groupRows = [];
    activeGroupIndex = -1;
    activeStage = 0;
    phaseLabel = "";

    try {
      const fillOptions: ApplyFillOptions | undefined = fillSchema
        ? {
            requested: true,
            nameField: fillBothBlank ? null : fillNameField,
            codeField: fillBothBlank ? null : fillCodeField,
            depthColumn: fillDepthColumn,
          }
        : undefined;

      const result = await runEdgeMatch(
        duckdbState.db!,
        duckdbState.conn!,
        inputFiles,
        overlayFiles,
        onProgress,
        { overlayMatchColumn: overlayMatchColumn ?? undefined, inputMatchColumn: inputMatchColumn ?? undefined },
        passthrough,
        fillOptions,
        perFeature,
      );
      resultGeoJSON = result.geojson;
      showSide = "b";
      overlayOutlineGeoJSON = result.overlayOutlineGeojson;
      resultBounds = result.bounds;
      unassignedCount = result.unassignedCount;
      droppedCount = result.droppedCount;
      passthroughCount = result.passthroughCount;
      codeMismatchCount = result.codeMismatchCount;
      codeFallbackCount = result.codeFallbackCount;
      microCount = result.microCount;
      gapCount = result.gapCount;
      clipEmptyCount = result.clipEmptyCount;
      assignedOverlayLabel = result.assignedOverlayLabel;
      inputColumns = result.inputColumns;
      overlayColumns = result.overlayColumns;
      phaseLabel = "Done";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      resetStream();
      activeOverlayFid = null;
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
      <DemoLink slug="edge-match" />
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
      <h2 class="step-heading">Input layer</h2>
      <DropZone
        bind:files={inputFiles}
        urlParam="input"
        disabled={running}
        helpText="The layer to match and extend — any polygon set, any admin level. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Overlay layer</h2>
      <DropZone
        bind:files={overlayFiles}
        urlParam="overlay"
        disabled={running}
        helpText="The boundary to match and clip against, one level up or many."
      />
    </section>

    <section class="step">
      <h2 class="step-heading">Fitting</h2>
      <p class="fit-mode">
        {perFeature
          ? "Each input feature goes into the overlay feature it overlaps most."
          : "All input features go into the one overlay feature most of them overlap."}
        <button class="link-btn" disabled={running} onclick={() => (perFeature = !perFeature)}>
          {perFeature ? "Fit all into one" : "Fit each separately"}
        </button>
      </p>
    </section>

    {#if inputColumns && overlayColumns}
      <section class="step">
        <h2 class="step-heading">Code join (optional)</h2>
        <p class="hint">
          Wins over spatial overlap wherever the codes agree on an overlay feature the input feature overlaps at all,
          falls back to spatial when no code match exists.
        </p>
        <div class="match-cols">
          <label class="match-field">
            <span>Fine code</span>
            <select bind:value={inputMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each inputColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
          <label class="match-field">
            <span>Coarse code</span>
            <select bind:value={overlayMatchColumn} disabled={running}>
              <option value={null}>(none)</option>
              {#each overlayColumns.all as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          </label>
        </div>
      </section>
    {/if}

    {#if inputColumns && overlayColumns}
      <section class="step">
        <h2 class="step-heading">Unmatched fine units</h2>
        <label class="passthrough-field">
          <input type="checkbox" bind:checked={passthrough} disabled={running} />
          <span>Include zero-overlap units unclipped, instead of dropping them</span>
        </label>
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
                  <span class="group-count">{row.inputCount}</span>
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

    {#if resultGeoJSON && !perFeature && assignedOverlayLabel}
      <p class="fit-mode">Fitted into {assignedOverlayLabel}.</p>
    {/if}

    {#if (unassignedCount !== null && unassignedCount > 0) || (droppedCount !== null && droppedCount > 0) || (codeMismatchCount !== null && codeMismatchCount > 0) || (codeFallbackCount !== null && codeFallbackCount > 0) || (microCount !== null && microCount > 0) || (gapCount !== null && gapCount > 0) || (clipEmptyCount !== null && clipEmptyCount > 0)}
      <div class="warn-panel">
        {#if clipEmptyCount !== null && clipEmptyCount > 0}
          <p>
            {clipEmptyCount} input feature{clipEmptyCount === 1 ? " falls" : "s fall"} outside
            {perFeature ? "their overlay feature" : "it"} and {clipEmptyCount === 1 ? "was" : "were"} clipped
            away.
            {#if !perFeature}
              <button class="link-btn" disabled={running} onclick={() => (perFeature = true)}>
                Fit each separately
              </button>
            {/if}
          </p>
        {/if}
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
            different overlay than the spatial overlap pick; the code match won.
          </p>
        {/if}
        {#if codeFallbackCount !== null && codeFallbackCount > 0}
          <p>
            {codeFallbackCount} unit{codeFallbackCount === 1 ? "" : "s"} had no overlapping code
            match and fell back to the spatial pick.
          </p>
        {/if}
        {#if microCount !== null && microCount > 0}
          <p>
            {microCount} micro-polygon{microCount === 1 ? "" : "s"} (narrower than the snap tolerance)
            merged into a neighbouring feature or dropped.
          </p>
        {/if}
        {#if gapCount !== null && gapCount > 0}
          <p>
            {gapCount} gap{gapCount === 1 ? "" : "s"} wider than the snap tolerance remain in the
            output.
          </p>
        {/if}
        <DownloadMenu
          primaryLabel="Download issues"
          filenameStem={fileStem(inputFiles[0])}
          exportSource="match_issues"
        />
      </div>
    {/if}

    {#if resultGeoJSON}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(inputFiles[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="match"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    {#if resultGeoJSON}
      <SideToggle bind:side={showSide} labels={["Original", "Matched"]} disabled={running} />
    {/if}
    <MapView
      resultGeojson={resultGeoJSON}
      inputGeojson={inputGeoJSON}
      streamGeojson={streamGeoJSON}
      overlayOutlineGeojson={overlayOutlineGeoJSON}
      {activeOverlayFid}
      {showSide}
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

  .fit-mode {
    font-size: 0.8rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: #2563eb;
    text-decoration: underline;
    cursor: pointer;
  }

  .link-btn:disabled {
    color: #9ca3af;
    cursor: default;
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

  .passthrough-field,
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
    position: relative;
    height: 100%;
    overflow: hidden;
  }
</style>
