<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import {
    boolParam,
    choiceParam,
    numberParam,
    textParam,
    syncParam,
    type ParamCodec,
  } from "$lib/utils/syncParam.svelte";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import { onMount, untrack } from "svelte";
  import { loadSide } from "./pipeline/load";
  import { parseMinWidth, runCodeUpdate, type ChangeRow, type TargetSchema } from "./pipeline/index";

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
  let delimMode = $state<"auto" | "none" | "char">("auto");
  let delimChar = $state("");
  let minWidth = $state("");
  let codeColA = $state("");
  let codeColB = $state("");
  let nameColA = $state("");
  let nameColB = $state("");
  let nameFieldA = $state("");
  let codeFieldA = $state("");
  let nameFieldB = $state("");
  let codeFieldB = $state("");

  let tauMatch = $state(0.8);
  let tauSame = $state(0.98);
  let linkByCode = $state(false);
  let linkByName = $state(false);
  let linkMode = $state<"either" | "both">("either");
  syncParam("root", textParam, () => rootCode, (v) => (rootCode = v));
  // Absent is auto-detect, "none" is no delimiter, anything else the character itself.
  const delimParam: ParamCodec<string | null> = {
    parse: (raw) => (raw === "" ? undefined : raw === "none" ? "" : raw),
    format: (value) => (value === null ? "" : value === "" ? "none" : value),
  };
  const delimiter = $derived(delimMode === "auto" ? null : delimMode === "none" ? "" : delimChar);
  syncParam("delim", delimParam, () => delimiter, (v) => {
    delimMode = v === null ? "auto" : v === "" ? "none" : "char";
    if (v) delimChar = v;
  });
  syncParam("width", textParam, () => minWidth, (v) => (minWidth = v));
  syncParam("code-col-a", textParam, () => codeColA, (v) => (codeColA = v));
  syncParam("code-col-b", textParam, () => codeColB, (v) => (codeColB = v));
  syncParam("name-col-a", textParam, () => nameColA, (v) => (nameColA = v));
  syncParam("name-col-b", textParam, () => nameColB, (v) => (nameColB = v));
  syncParam("name-a", textParam, () => nameFieldA, (v) => (nameFieldA = v));
  syncParam("code-a", textParam, () => codeFieldA, (v) => (codeFieldA = v));
  syncParam("name-b", textParam, () => nameFieldB, (v) => (nameFieldB = v));
  syncParam("code-b", textParam, () => codeFieldB, (v) => (codeFieldB = v));
  syncParam("match", numberParam, () => tauMatch, (v) => (tauMatch = v));
  syncParam("same", numberParam, () => tauSame, (v) => (tauSame = v));
  syncParam("by-code", boolParam, () => linkByCode, (v) => (linkByCode = v));
  syncParam("by-name", boolParam, () => linkByName, (v) => (linkByName = v));
  syncParam("link", choiceParam(["either", "both"] as const), () => linkMode, (v) => (linkMode = v));

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
        delimiter,
        minWidth: minWidth.trim() === "" ? null : minWidth,
        codeColumnA: linkByCode && codeColA.trim() !== "" ? codeColA.trim() : null,
        codeColumnB: linkByCode && codeColB.trim() !== "" ? codeColB.trim() : null,
        nameColumnA: linkByName && nameColA.trim() !== "" ? nameColA.trim() : null,
        nameColumnB: linkByName && nameColB.trim() !== "" ? nameColB.trim() : null,
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
  const minWidthError = $derived.by(() => {
    if (minWidth.trim() === "") return null;
    try {
      parseMinWidth(minWidth);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  const formatOverrideValid = $derived(
    (delimMode !== "char" || [...delimChar].length === 1) && minWidthError === null,
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
            urlParam="old"
            disabled={running || loadingSide === "a"}
            helpText="Polygon layer with an existing hierarchical code."
          />
        </div>
        <div>
          <label class="zone-label">NEW (uncoded candidate)</label>
          <DropZone
            bind:files={filesB}
            urlParam="new"
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
        <p class="field-hint">Anything left blank or on auto is detected from OLD's own codes.</p>
        <label class="field">
          <span>Root code</span>
          <input type="text" bind:value={rootCode} placeholder="auto-detect" disabled={running} />
        </label>
        <label class="field">
          <span>Delimiter</span>
          <select bind:value={delimMode} disabled={running}>
            <option value="auto">Auto-detect</option>
            <option value="none">None</option>
            <option value="char">Character</option>
          </select>
        </label>
        {#if delimMode === "char"}
          <label class="field">
            <span>Delimiter character</span>
            <input type="text" maxlength="1" bind:value={delimChar} disabled={running} />
          </label>
        {/if}
        <label class="field">
          <span>Min width</span>
          <input
            type="text"
            bind:value={minWidth}
            placeholder="auto-detect (or 3, 2,2,4, auto)"
            disabled={running}
          />
        </label>
        {#if minWidthError}<p class="field-error">{minWidthError}</p>{/if}
        {#if delimMode === "char" && [...delimChar].length !== 1}
          <p class="field-error">Enter one delimiter character.</p>
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
        {#if linkByCode}
          <label class="field">
            <span>Code column to compare, OLD</span>
            <input type="text" bind:value={codeColA} placeholder="each level's own" disabled={running} />
          </label>
          <label class="field">
            <span>Code column to compare, NEW</span>
            <input type="text" bind:value={codeColB} placeholder="each level's own" disabled={running} />
          </label>
        {/if}
        <label class="checkbox">
          <input type="checkbox" bind:checked={linkByName} disabled={running} />
          <span>Link by name (each level's own name column)</span>
        </label>
        {#if linkByName}
          <label class="field">
            <span>Name column to compare, OLD</span>
            <input type="text" bind:value={nameColA} placeholder="each level's own" disabled={running} />
          </label>
          <label class="field">
            <span>Name column to compare, NEW</span>
            <input type="text" bind:value={nameColB} placeholder="each level's own" disabled={running} />
          </label>
        {/if}
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
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON}
      showSide={resultGeoJSON ? "b" : undefined}
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
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--hdx-neutral-1);
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
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
    color: var(--hdx-neutral-7);
    margin-bottom: 0.2rem;
  }

  .status {
    font-size: 0.85rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .field-hint {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-8);
  }

  .field input,
  .field select {
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-md);
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .fieldset {
    border: 1px solid var(--hdx-neutral-1);
    border-radius: var(--hdx-radius-md);
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--hdx-neutral-7);
    padding: 0 0.3rem;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--hdx-error-6);
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
    color: var(--hdx-neutral-8);
  }

  .run-btn {
    background: var(--hdx-primary-5);
    color: var(--hdx-neutral-0);
    border: none;
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .run-btn:hover:not(:disabled) {
    background: var(--hdx-primary-9);
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
    background: var(--hdx-error-05);
    border: 1px solid var(--hdx-error-3);
    border-radius: var(--hdx-radius-md);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--hdx-error-6);
    word-break: break-word;
  }

  .summary-line {
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
    line-height: 1.4;
    margin: 0;
  }

  .changelog-scroll {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--hdx-neutral-1);
    border-radius: var(--hdx-radius-md);
  }

  .changelog-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .changelog-table thead th {
    position: sticky;
    top: 0;
    background: var(--hdx-neutral-01);
    text-align: left;
    font-weight: 600;
    color: var(--hdx-neutral-7);
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--hdx-neutral-1);
  }

  .changelog-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--hdx-neutral-05);
    color: var(--hdx-neutral-8);
  }

  .privacy {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0;
    margin-top: auto;
  }

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
