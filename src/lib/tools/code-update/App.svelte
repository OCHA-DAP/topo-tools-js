<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import { onMount, untrack } from "svelte";
  import { loadSide } from "./pipeline/load";
  import { runCodeUpdate, type ChangeRow, type TargetSchema } from "./pipeline/index";

  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  let filesA = $state<File[]>([]);
  let filesB = $state<File[]>([]);
  let loadingSide = $state<"a" | "b" | null>(null);
  let loadedA = $state(false);
  let loadedB = $state(false);
  let loadError = $state<string | null>(null);
  let originalGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let rootCode = $state("");
  let delimiter = $state("");
  let minWidth = $state("");
  let nameFieldA = $state("");
  let codeFieldA = $state("");
  let nameFieldB = $state("");
  let codeFieldB = $state("");

  let tauMatch = $state(0.8);
  let tauSame = $state(0.98);
  let linkByCode = $state(false);
  let linkByName = $state(false);
  let linkMode = $state<"either" | "both">("either");

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let levelCount = $state(0);
  let changelog = $state<ChangeRow[]>([]);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  async function computeLoadedBounds(): Promise<[number, number, number, number] | null> {
    const conn = duckdbState.conn!;
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM (SELECT geom FROM cu_a_layer_01 UNION ALL SELECT geom FROM cu_b_layer_01)
      WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v)) ? [xmin, ymin, xmax, ymax] : null;
  }

  function resetRun(): void {
    ran = false;
    error = null;
    resultGeoJSON = null;
    resultBounds = null;
    levelCount = 0;
    changelog = [];
  }

  $effect(() => {
    const f = filesA;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "a") return;
      loadedA = false;
      resetRun();
      loadSideThen("a");
    });
  });

  $effect(() => {
    const f = filesB;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "b") return;
      loadedB = false;
      resetRun();
      loadSideThen("b");
    });
  });

  async function loadSideThen(side: "a" | "b"): Promise<void> {
    clearMap?.();
    loadError = null;
    loadingSide = side;
    try {
      const files = side === "a" ? filesA : filesB;
      await loadSide(duckdbState.db!, duckdbState.conn!, side, files);
      if (side === "a") loadedA = true;
      else {
        originalGeoJSON = await tableToGeoJSON(duckdbState.conn!, "cu_b_layer_01", null);
        loadedB = true;
      }
      if (loadedA && loadedB) loadedBounds = await computeLoadedBounds();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingSide = null;
    }
  }

  function schemaFrom(nameField: string, codeField: string): TargetSchema | null {
    return nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resetRun();

    try {
      const result = await runCodeUpdate(duckdbState.conn!, {
        schemaA: schemaFrom(nameFieldA, codeFieldA),
        schemaB: schemaFrom(nameFieldB, codeFieldB),
        rootCode: rootCode.trim() === "" ? null : rootCode.trim(),
        delimiter: delimiter === "" ? null : delimiter,
        minWidth: minWidth.trim() === "" ? null : Number(minWidth),
        tauMatch,
        tauSame,
        linkByCode,
        linkByName,
        linkMode,
      });
      resultGeoJSON = result.resultGeoJSON;
      resultBounds = result.bounds;
      levelCount = result.levelCount;
      changelog = result.changelog;
      ran = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function fileStem(a: File[], b: File[]): string {
    const stem = (files: File[]) => files[0]?.name.replace(/\.[^.]+$/, "") ?? "";
    const sa = stem(a);
    const sb = stem(b);
    if (!sa && !sb) return "code_update";
    if (!sa || !sb || sa === sb) return sa || sb;
    return `${sa}_${sb}`;
  }

  const bothBlankA = $derived(nameFieldA.trim() === "" && codeFieldA.trim() === "");
  const oneBlankA = $derived((nameFieldA.trim() === "") !== (codeFieldA.trim() === ""));
  const bothBlankB = $derived(nameFieldB.trim() === "" && codeFieldB.trim() === "");
  const oneBlankB = $derived((nameFieldB.trim() === "") !== (codeFieldB.trim() === ""));
  const templatesValid = $derived(
    !oneBlankA &&
      !oneBlankB &&
      (bothBlankA || (nameFieldA.includes("{n}") && codeFieldA.includes("{n}"))) &&
      (bothBlankB || (nameFieldB.includes("{n}") && codeFieldB.includes("{n}"))),
  );
  const formatOverrideValid = $derived(
    (rootCode.trim() === "" && delimiter === "" && minWidth.trim() === "") ||
      (rootCode.trim() !== "" && delimiter.length === 1 && Number(minWidth) >= 1),
  );
  const canRun = $derived(loadedA && loadedB && templatesValid && formatOverrideValid && !loadingSide);

  const outcomeSummary = $derived.by(() => {
    const counts: Record<string, number> = { retained: 0, new: 0, retired: 0, overflow: 0 };
    for (const row of changelog) counts[row.codeOutcome] = (counts[row.codeOutcome] ?? 0) + 1;
    return counts;
  });
</script>

<div class="layout">
  <aside class="sidebar">
    <header>
      <a class="back" href={base}>&larr; Topology Tools</a>
      <h1>Code Update</h1>
      <p class="blurb">
        Reconcile an already-coded OLD layer against an uncoded NEW candidate. Unchanged and renamed
        units keep their code; modified, relocated, split, merged, and newly created units get a
        fresh one under their re-derived parent.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="step">
      <h2 class="step-heading">Layers</h2>
      <div class="dropzones">
        <div>
          <label class="zone-label">OLD (already coded)</label>
          <DropZone
            bind:files={filesA}
            disabled={running || loadingSide === "a"}
            helpText="Polygon layer with an existing hierarchical code."
          />
        </div>
        <div>
          <label class="zone-label">NEW (uncoded candidate)</label>
          <DropZone
            bind:files={filesB}
            disabled={running || loadingSide === "b"}
            helpText="Polygon layer to reconcile against OLD, same coverage area."
          />
        </div>
      </div>
      {#if loadingSide === "a"}<p class="status">Loading OLD...</p>{/if}
      {#if loadingSide === "b"}<p class="status">Loading NEW...</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </section>

    {#if loadedA && loadedB}
      <section class="step">
        <h2 class="step-heading">Code format override</h2>
        <p class="field-hint">Leave all three blank to detect from OLD's own finest-level code.</p>
        <label class="field">
          <span>Root code</span>
          <input type="text" bind:value={rootCode} placeholder="auto-detect" disabled={running} />
        </label>
        <label class="field">
          <span>Delimiter</span>
          <input type="text" maxlength="1" bind:value={delimiter} placeholder="auto-detect" disabled={running} />
        </label>
        <label class="field">
          <span>Min width</span>
          <input
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            bind:value={minWidth}
            placeholder="auto-detect"
            disabled={running}
          />
        </label>
        {#if !formatOverrideValid}
          <p class="field-error">Set all three fields, or leave all three blank to auto-detect.</p>
        {/if}
      </section>

      <section class="step">
        <h2 class="step-heading">Target schema</h2>
        <p class="field-hint">
          Naming templates for a resolved level's number. Leave both blank per side to auto-detect
          the hierarchy structurally instead.
        </p>
        <fieldset class="fieldset">
          <legend>OLD</legend>
          <label class="field">
            <span>Name template</span>
            <input type="text" bind:value={nameFieldA} placeholder="auto-detect" disabled={running} />
          </label>
          <label class="field">
            <span>Code template</span>
            <input type="text" bind:value={codeFieldA} placeholder="auto-detect" disabled={running} />
          </label>
        </fieldset>
        <fieldset class="fieldset">
          <legend>NEW</legend>
          <label class="field">
            <span>Name template</span>
            <input type="text" bind:value={nameFieldB} placeholder="auto-detect" disabled={running} />
          </label>
          <label class="field">
            <span>Code template</span>
            <input type="text" bind:value={codeFieldB} placeholder="auto-detect" disabled={running} />
          </label>
        </fieldset>
        {#if !templatesValid}
          <p class="field-error">Both templates must be set per side, or both left blank, and contain "{"{n}"}".</p>
        {/if}
      </section>

      <section class="step">
        <h2 class="step-heading">Thresholds</h2>
        <label class="slider">
          <span>Matched: {Math.round(tauSame * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" bind:value={tauSame} disabled={running} />
          <p class="field-hint">
            How much a 1:1 matched pair must overlap (IoU) to classify as <em>unchanged</em> rather
            than <em>modified</em>.
          </p>
        </label>
        <label class="slider">
          <span>Related: {Math.round(tauMatch * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" bind:value={tauMatch} disabled={running} />
          <p class="field-hint">How much of either polygon must overlap the other to be considered related.</p>
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={linkByCode} disabled={running} />
          <span>Link by code (each level's own hierarchy code column)</span>
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={linkByName} disabled={running} />
          <span>Link by name (each level's own name column)</span>
        </label>
        {#if linkByCode && linkByName}
          <label class="field">
            <span>Link mode</span>
            <select bind:value={linkMode} disabled={running}>
              <option value="either">Either matches</option>
              <option value="both">Both must match</option>
            </select>
          </label>
        {/if}
        <button class="run-btn" onclick={handleRun} disabled={!canRun || running}>
          {running ? "Reconciling..." : "Run"}
        </button>
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if ran}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        <p class="summary-line">
          {levelCount} level{levelCount === 1 ? "" : "s"} reconciled. {outcomeSummary.retained} retained,
          {outcomeSummary.new} new, {outcomeSummary.retired} retired, {outcomeSummary.overflow} overflow.
        </p>
        <div class="changelog-scroll">
          <table class="changelog-table">
            <thead>
              <tr>
                <th>Lvl</th>
                <th>Old</th>
                <th>New</th>
                <th>Class</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {#each changelog as row, i (row.level + "/" + row.clusterId + "/" + i)}
                <tr title={row.reason}>
                  <td>{row.level}</td>
                  <td>{row.oldCode ?? "(none)"}</td>
                  <td>{row.newCode ?? "(none)"}</td>
                  <td>{row.relationshipClass}</td>
                  <td>{row.codeOutcome}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(filesA, filesB)}
          cachedGeoJSON={resultGeoJSON}
          exportSource="code_update"
        />
        <DownloadMenu
          primaryLabel="Download Changelog CSV"
          filenameStem={fileStem(filesA, filesB)}
          exportSource="code_update_changelog"
        />
      </section>
    {/if}

    <p class="privacy">Your files never leave your device.</p>
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON ?? originalGeoJSON}
      originalGeojson={resultGeoJSON ? originalGeoJSON : null}
      bounds={resultBounds ?? loadedBounds}
      processing={loadingSide !== null || running}
      registerClear={(fn: () => void) => {
        clearMap = fn;
      }}
    />
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 360px 1fr;
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
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }

  .dropzones {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .zone-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    margin-bottom: 0.2rem;
  }

  .status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .field-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .field input,
  .field select {
    padding: 0.4rem 0.55rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    padding: 0 0.3rem;
  }

  .field-error {
    font-size: 0.75rem;
    color: #b91c1c;
    margin: 0;
  }

  .slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }

  .slider input[type="range"] {
    width: 100%;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .run-btn {
    background: #1d4ed8;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .run-btn:hover:not(:disabled) {
    background: #1e40af;
  }

  .run-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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

  .summary-line {
    font-size: 0.8rem;
    color: #6b7280;
    line-height: 1.4;
    margin: 0;
  }

  .changelog-scroll {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
  }

  .changelog-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .changelog-table thead th {
    position: sticky;
    top: 0;
    background: #f9fafb;
    text-align: left;
    font-weight: 600;
    color: #4b5563;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .changelog-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid #f3f4f6;
    color: #374151;
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
