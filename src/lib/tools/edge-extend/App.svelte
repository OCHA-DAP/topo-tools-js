<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { getOriginalGeojson, PipelineError, runPipeline } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  const STAGE_LABELS = [
    "Load file",
    "Extract boundary lines",
    "Interpolate points",
    "Build Voronoi diagram",
    "Merge polygons",
  ];

  let files = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-5=active stage, 6=done
  let errorStage = $state(0); // stage number that failed, 0=none
  let stageLabel = $state("");
  let resultGeoJSON = $state<string | null>(null);
  let changedGeoJSON = $state<string | null>(null);
  let showSide = $state<"a" | "b">("b");
  let originalGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let error = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

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
    changedGeoJSON = null;
    originalGeoJSON = null;
    resultBounds = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      currentStage = 1;
      stageLabel = "Loading file…";
      await loadFile(duckdbState.db!, duckdbState.conn!, files);

      const origGeoJSON = await getOriginalGeojson(duckdbState.conn!);
      const bboxResult = await duckdbState.conn!.query(`
        SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
               MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
        FROM layer_01 WHERE geom IS NOT NULL
      `);
      const bboxRow = bboxResult.toArray()[0] as Record<string, number>;
      const { xmin, ymin, xmax, ymax } = bboxRow;
      if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
        resultBounds = [xmin, ymin, xmax, ymax];
      }
      originalGeoJSON = origGeoJSON;

      const result = await runPipeline(duckdbState.conn!, (stage, label) => {
        currentStage = stage;
        stageLabel = label;
      });

      resultGeoJSON = result.geojson;
      changedGeoJSON = result.changedGeoJSON;
      showSide = "b";
      resultBounds = result.bounds ?? resultBounds;
      currentStage = 6;
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
    if (currentStage === 6) return "done";
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
      <h1>Edge Extender</h1>
      <p class="blurb">
        Extend polygon boundaries outward to meet a parent boundary — for example ADM3 sub-national
        areas that fall short of their ADM0 country edge. Drop a polygon layer; the tool extends
        each polygon's edges outward via a Voronoi diagram.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layer" collapsed={resultGeoJSON !== null} detail={files[0]?.name ?? ""}>
      <DropZone
        bind:files
        urlParam="url"
        disabled={running}
        helpText="Polygon layer in WGS84 — admin boundaries, basins, etc. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
    </InputStep>

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

    {#if resultGeoJSON}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="extend"
        />
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="map-container">
    {#if resultGeoJSON}
      <SideToggle bind:side={showSide} labels={["Original", "Extended"]} disabled={running} />
    {/if}
    <MapView
      showSide={resultGeoJSON ? showSide : undefined}
      geojson={resultGeoJSON}
      changedGeojson={changedGeoJSON}
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

  .map-container {
    position: relative;
    height: 100%;
    overflow: hidden;
  }
</style>
