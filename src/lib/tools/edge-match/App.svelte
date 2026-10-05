<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { boolParam, choiceParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { onMount, untrack } from "svelte";
  import DemoLink from "$lib/components/DemoLink.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import DetachedNote from "$lib/components/DetachedNote.svelte";
  import MicroNote from "$lib/components/MicroNote.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import CodeJoinPicker from "$lib/components/CodeJoinPicker.svelte";
  import MapView from "./MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";
  import SegmentedControl from "$lib/components/SegmentedControl.svelte";
  import { runEdgeMatch, type EdgeMatchPhase } from "./pipeline/index";
  import type { MatchMode } from "./pipeline/assign";
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
  let detachedMergedCount = $state<number | null>(null);
  let detachedKeptCount = $state<number | null>(null);
  let assignedOverlayLabel = $state<string | null>(null);
  let passthrough = $state(false);
  let advancedOpen = $state(false);
  let matchMode = $state<MatchMode>("auto");
  // What the last run used; under "auto" this is the automatic pick.
  let resolvedMode = $state<"one" | "several" | null>(null);
  const perFeature = $derived(resolvedMode === "several");

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior, even when a plausible code column
  // exists. Repicking after a run reruns the whole pipeline, since a
  // reassigned input feature can move to a different group entirely.
  let inputColumns = $state<ColumnGuess | null>(null);
  let overlayColumns = $state<ColumnGuess | null>(null);
  let inputMatchColumn = $state<string | null>(null);
  let overlayMatchColumn = $state<string | null>(null);

  syncParam(
    "match",
    choiceParam(["auto", "one", "several"] as const),
    () => matchMode,
    (v) => (matchMode = v),
  );
  syncParam("passthrough", boolParam, () => passthrough, (v) => (passthrough = v));
  $effect(() => {
    if (passthrough) advancedOpen = true;
  });

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
    const _m = matchMode;
    untrack(() => {
      if (!resultGeoJSON || running) return;
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
    detachedMergedCount = null;
    detachedKeptCount = null;
    assignedOverlayLabel = null;
    groupRows = [];
    activeGroupIndex = -1;
    activeStage = 0;
    phaseLabel = "";

    try {
      const result = await runEdgeMatch(
        duckdbState.db!,
        duckdbState.conn!,
        inputFiles,
        overlayFiles,
        onProgress,
        { overlayMatchColumn: overlayMatchColumn ?? undefined, inputMatchColumn: inputMatchColumn ?? undefined },
        passthrough,
        matchMode,
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
      detachedMergedCount = result.detachedMergedCount;
      detachedKeptCount = result.detachedKeptCount;
      assignedOverlayLabel = result.assignedOverlayLabel;
      resolvedMode = result.mode;
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
        Fit an input polygon layer into an overlay boundary layer, extending edges so the result
        meets the boundary exactly. The layers can be adjacent levels (admin 4 into 3) or far apart
        (admin 4 straight into 0).
      </p>
      <p class="hint">
        The overlay layer should be a clean coverage. Run Topology Cleaner first if unsure.
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
        helpText="The layer to match and extend, any polygon set at any admin level. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
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
      <h2 class="step-heading">Match to how many overlay features?</h2>
      <SegmentedControl
        bind:value={
          () => (matchMode === "auto" ? resolvedMode : matchMode),
          (v) => {
            if (!(matchMode === "auto" && v === resolvedMode)) matchMode = v ?? "auto";
          }
        }
        options={[
          { value: "one", label: matchMode === "auto" && resolvedMode === "one" ? "One (auto)" : "One" },
          { value: "several", label: matchMode === "auto" && resolvedMode === "several" ? "Several (auto)" : "Several" },
        ]}
        label="Match to how many overlay features?"
        disabled={running}
      />
      {#if matchMode !== "auto"}
        <button class="link-btn auto-reset" disabled={running} onclick={() => (matchMode = "auto")}>Pick automatically</button>
      {/if}
    </section>

    <AdvancedOptions bind:open={advancedOpen}>
      {#if inputColumns && overlayColumns}
        <CodeJoinPicker
          inputColumns={inputColumns.all}
          overlayColumns={overlayColumns.all}
          bind:inputValue={inputMatchColumn}
          bind:overlayValue={overlayMatchColumn}
          hint="Match by a shared code column where the codes agree, falling back to overlap where they don't."
          disabled={running}
        />
      {/if}
      <label class="passthrough-field">
        <input type="checkbox" bind:checked={passthrough} disabled={running} />
        <span>Keep input features that overlap no overlay feature (unclipped)</span>
      </label>
    </AdvancedOptions>

    {#snippet groupList()}
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
    {/snippet}

    {#if running || groupRows.length > 0}
      <section class="step">
        {#if !running && phaseLabel === "Done" && groupRows.length > 0 && errorCount === 0}
          <details>
            <summary class="phase-label">Done: {doneCount}/{groupRows.length} groups</summary>
            {@render groupList()}
          </details>
        {:else}
          <p class="phase-label">{phaseLabel}</p>
          {#if groupRows.length > 0}
            <p class="group-summary">
              {doneCount}/{groupRows.length} groups done{errorCount > 0 ? ` · ${errorCount} failed` : ""}
            </p>
            {@render groupList()}
          {/if}
        {/if}
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if resultGeoJSON && !perFeature && assignedOverlayLabel}
      <p class="fit-mode">Matched to {assignedOverlayLabel}.</p>
    {/if}

    {#if (unassignedCount !== null && unassignedCount > 0) || (droppedCount !== null && droppedCount > 0) || (codeMismatchCount !== null && codeMismatchCount > 0) || (codeFallbackCount !== null && codeFallbackCount > 0) || (microCount !== null && microCount > 0) || (gapCount !== null && gapCount > 0) || (clipEmptyCount !== null && clipEmptyCount > 0) || (detachedMergedCount ?? 0) + (detachedKeptCount ?? 0) > 0}
      <div class="warn-panel">
        {#if clipEmptyCount !== null && clipEmptyCount > 0}
          <p>
            {clipEmptyCount} input feature{clipEmptyCount === 1 ? " falls" : "s fall"} outside
            {perFeature ? "their overlay feature" : "it"} and {clipEmptyCount === 1 ? "was" : "were"} clipped
            away.
            {#if !perFeature}
              <button class="link-btn" disabled={running} onclick={() => (matchMode = "several")}>
                Switch to Several
              </button>
            {/if}
          </p>
        {/if}
        {#if unassignedCount !== null && unassignedCount > 0}
          <p>
            {unassignedCount} input feature{unassignedCount === 1 ? "" : "s"} overlap no overlay
            feature{passthrough
              ? `; ${passthroughCount ?? 0} ${(passthroughCount ?? 0) === 1 ? "was" : "were"} kept unclipped`
              : ` and ${unassignedCount === 1 ? "was" : "were"} left out`}.
          </p>
        {/if}
        {#if droppedCount !== null && droppedCount > 0}
          <p>
            {droppedCount} input feature{droppedCount === 1 ? " was" : "s were"} left out because
            {droppedCount === 1 ? "its" : "their"} group failed.
          </p>
        {/if}
        {#if codeMismatchCount !== null && codeMismatchCount > 0}
          <p>
            {codeMismatchCount} input feature{codeMismatchCount === 1 ? " was" : "s were"} matched by
            code to a different overlay feature than overlap alone would pick.
          </p>
        {/if}
        {#if codeFallbackCount !== null && codeFallbackCount > 0}
          <p>
            {codeFallbackCount} input feature{codeFallbackCount === 1 ? "" : "s"} had no matching
            code and {codeFallbackCount === 1 ? "was" : "were"} matched by overlap.
          </p>
        {/if}
        {#if microCount !== null && microCount > 0}
          <p><MicroNote count={microCount} /></p>
        {/if}
        {#if (detachedMergedCount ?? 0) + (detachedKeptCount ?? 0) > 0}
          <p><DetachedNote merged={detachedMergedCount ?? 0} kept={detachedKeptCount ?? 0} /></p>
        {/if}
        {#if gapCount !== null && gapCount > 0}
          <p>{gapCount} gap{gapCount === 1 ? " remains" : "s remain"} in the result.</p>
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
  header .hint,
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

  .hint {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0.5rem 0 0;
    line-height: 1.4;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--hdx-neutral-1);
  }

  .fit-mode {
    font-size: 0.8rem;
    color: var(--hdx-neutral-8);
    margin: 0;
    line-height: 1.5;
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--hdx-primary-5);
    text-decoration: underline;
    cursor: pointer;
  }

  .auto-reset {
    align-self: flex-start;
    font-size: 0.75rem;
  }

  .link-btn:disabled {
    color: var(--hdx-neutral-5);
    cursor: default;
  }

  .step-heading {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
    margin: 0;
  }




  .passthrough-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-8);
  }




  .phase-label {
    font-size: 0.85rem;
    color: var(--hdx-neutral-8);
    margin: 0;
    font-weight: 500;
  }

  summary.phase-label {
    cursor: pointer;
    user-select: none;
  }

  details > .groups {
    margin-top: 0.5rem;
  }

  .group-summary {
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
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
    color: var(--hdx-neutral-7);
  }

  .groups > li.done .group-dot {
    color: var(--hdx-success-5);
  }

  .groups > li.running .group-dot {
    color: var(--hdx-primary-5);
  }

  .groups > li.error .group-dot {
    color: var(--hdx-error-5);
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
    color: var(--hdx-neutral-7);
    font-variant-numeric: tabular-nums;
  }

  .group-error {
    margin: 0.15rem 0 0 1.1rem;
    font-size: 0.75rem;
    color: var(--hdx-error-5);
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
    color: var(--hdx-neutral-5);
  }

  .stages li.done {
    color: var(--hdx-success-5);
  }

  .stages li.active {
    color: var(--hdx-primary-5);
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
    font-size: 0.8rem;
    color: var(--hdx-warning-7);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .warn-panel p {
    margin: 0;
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
