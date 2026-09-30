import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { gatedCoverageClean, hasCoverageViolations } from "$lib/db/coverageClean";
import { buildGapTable, hasMicroPolygons, hasNoiseFloorGap } from "$lib/db/coverage";
import { gapIssuesSql } from "$lib/db/issues";
import { tableToGeoJSON } from "$lib/db/geojson";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import {
  CODE_FALLBACK_REASON,
  CODE_MISMATCH_REASON,
  type MatchColumnOptions,
} from "$lib/db/codeJoin";
import { applyOptionalFill, type ApplyFillOptions } from "$lib/db/fillCompose";
import { CLIP_EMPTY_REASON } from "$lib/db/assignOne";
import { dropInternalTables } from "$lib/tools/edge-extend/pipeline/index";
import { loadLayers } from "./load";
import { computeAssignment } from "./assign";
import {
  listGroups,
  PASSTHROUGH_OVERLAY_FID,
  runGroups,
  type GroupInfo,
  type GroupResult,
} from "./groups";

export type EdgeMatchPhase =
  | { phase: "loading" }
  | { phase: "assigning" }
  | { phase: "groups-listed"; groups: GroupInfo[] }
  | {
      phase: "group-stage";
      groupIndex: number;
      groupTotal: number;
      group: GroupInfo;
      stage: number;
      stageLabel: string;
    }
  | { phase: "group-done"; groupIndex: number; groupTotal: number; result: GroupResult };

export type EdgeMatchProgressFn = (event: EdgeMatchPhase) => void;

export interface EdgeMatchResult {
  geojson: string;
  bounds: [number, number, number, number] | null;
  groupResults: GroupResult[];
  unassignedCount: number;
  droppedCount: number;
  passthroughCount: number;
  codeMismatchCount: number;
  codeFallbackCount: number;
  microCount: number;
  gapCount: number;
  clipEmptyCount: number;
  // Assign-one only: the winner overlay feature's label.
  assignedOverlayLabel: string | null;
  inputColumns: ColumnGuess;
  overlayColumns: ColumnGuess;
  // Geometry-only outline of the overlay layer, so the map can show it as a
  // static reference layer alongside the per-group colored result.
  overlayOutlineGeojson: string;
}

// Combines every excluded/flagged input feature (unassigned, dropped-group, and
// code-mismatch/code-fallback per docs/adr/0045) into one exportable table.
async function buildIssuesTable(
  conn: AsyncDuckDBConnection,
): Promise<{ dropped: number; passthrough: number; clipEmpty: number }> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_issues AS
    SELECT 'unassigned-' || fid AS key, 'unassigned' AS kind,
           fid AS unit_a, NULL::BIGINT AS unit_b, NULL::BIGINT AS overlay_fid,
           NULL::VARCHAR AS reason, geom
    FROM ge_unassigned
    WHERE fid NOT IN (SELECT input_fid FROM ge_assignment)
    UNION ALL
    SELECT 'dropped_group-' || unit_a AS key, 'dropped_group' AS kind,
           unit_a, NULL, overlay_fid AS overlay_fid, reason, geom
    FROM ge_dropped
    UNION ALL
    SELECT 'passthrough-' || ga.input_fid AS key, 'passthrough' AS kind,
           ga.input_fid AS unit_a, NULL, ga.overlay_fid AS overlay_fid, NULL::VARCHAR AS reason, c.geom
    FROM ge_assignment ga JOIN input_layer_01 c ON c.fid = ga.input_fid
    WHERE ga.overlay_fid = ${PASSTHROUGH_OVERLAY_FID} AND ga.input_fid IN (SELECT fid FROM ge_results)
    UNION ALL
    SELECT 'code_mismatch-' || a.input_fid AS key, 'code-mismatch' AS kind,
           a.input_fid AS unit_a, NULL, a.overlay_fid AS overlay_fid, '${CODE_MISMATCH_REASON}' AS reason, c.geom
    FROM ge_assignment a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.assignment_method = 'code' AND a.spatial_agrees = FALSE
    UNION ALL
    SELECT 'code_fallback-' || a.input_fid AS key, 'code-fallback' AS kind,
           a.input_fid AS unit_a, NULL, a.overlay_fid AS overlay_fid, '${CODE_FALLBACK_REASON}' AS reason, c.geom
    FROM ge_assignment a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.assignment_method = 'spatial_fallback'
    UNION ALL
    SELECT 'clip-empty-' || unit_a AS key, 'clip-empty' AS kind,
           unit_a, NULL, overlay_fid, '${CLIP_EMPTY_REASON}' AS reason, geom
    FROM ge_clip_empty
  `);
  await conn.query("DROP TABLE IF EXISTS ge_clip_empty");
  const [droppedRes, passthroughRes, clipEmptyRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM ge_dropped"),
    conn.query(`SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'passthrough'`),
    conn.query(`SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'clip-empty'`),
  ]);
  return {
    dropped: Number((droppedRes.toArray()[0] as { n: bigint | number }).n),
    passthrough: Number((passthroughRes.toArray()[0] as { n: bigint | number }).n),
    clipEmpty: Number((clipEmptyRes.toArray()[0] as { n: bigint | number }).n),
  };
}

async function appendMicroIssues(conn: AsyncDuckDBConnection): Promise<number> {
  const r = await conn.query(
    "SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name = 'ge_micro'",
  );
  if (Number((r.toArray()[0] as { n: bigint | number }).n) === 0) return 0;
  await conn.query(`--sql
    INSERT INTO ge_issues BY NAME
    SELECT key, kind, unit_a, unit_b, reason, geom FROM ge_micro
  `);
  const n = await conn.query("SELECT COUNT(*) AS n FROM ge_micro");
  await conn.query("DROP TABLE ge_micro");
  return Number((n.toArray()[0] as { n: bigint | number }).n);
}

async function appendGapIssues(conn: AsyncDuckDBConnection): Promise<number> {
  try {
    await buildGapTable(conn, "ge_gap_regions", "ge_results");
    await conn.query(`--sql
      INSERT INTO ge_issues BY NAME
      SELECT key, kind, reason, geom FROM (${gapIssuesSql("ge_gap_regions")})
    `);
    const r = await conn.query("SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'gap'");
    return Number((r.toArray()[0] as { n: bigint | number }).n);
  } finally {
    await conn.query("DROP TABLE IF EXISTS ge_gap_regions");
  }
}

async function buildResultsAttrTable(conn: AsyncDuckDBConnection): Promise<void> {
  const overlayDesc = await conn.query("DESCRIBE overlay_layer_attr");
  const overlayCols = (overlayDesc.toArray() as Array<{ column_name: string }>)
    .map((r) => r.column_name)
    .filter((c) => c !== "fid");
  // Overlay feature attribute columns are prefixed to avoid silently colliding with
  // (and shadowing) an input-layer column of the same name in the SELECT *.
  const overlayExprs = overlayCols.map(
    (c) => `ca.${JSON.stringify(c)} AS ${JSON.stringify(`overlay_${c}`)}`,
  );
  const overlaySelect = overlayExprs.length > 0 ? ", " + overlayExprs.join(", ") : "";

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_results_attr AS
    SELECT fa.*, ga.overlay_fid AS group_id${overlaySelect}
    FROM input_layer_attr fa
    JOIN ge_assignment ga ON ga.input_fid = fa.fid
    LEFT JOIN overlay_layer_attr ca ON ca.fid = ga.overlay_fid
  `);
}

// Warn-only topology check on the final assembled output, matching
// edge-extend's own runValidation pattern — but tolerant at SNAP_TOLERANCE
// (hasNoiseFloorGap), not zero-tolerance: unlike extend, match clips against
// an overlay layer whose own shape can have a real, legitimate interior
// hole (see docs/adr/0028), so only a noise-floor-scale leftover gap is an
// unambiguous bug signal here.
async function runValidation(conn: AsyncDuckDBConnection, table: string): Promise<void> {
  try {
    if (await hasCoverageViolations(conn, table)) {
      console.warn(`OVERLAPS in ${table}`);
    }
  } catch (e) {
    console.warn("overlap check failed:", e);
  }

  try {
    if (await hasNoiseFloorGap(conn, table)) {
      console.warn(`match: a noise-floor gap remains in ${table} after CoverageClean`);
    }
  } catch (e) {
    console.warn("gap check failed:", e);
  }

  try {
    if (await hasMicroPolygons(conn, table)) {
      console.warn(`match: a micro-polygon remains in ${table} after CoverageClean`);
    }
  } catch (e) {
    console.warn("micro-polygon check failed:", e);
  }
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ge_results WHERE geom IS NOT NULL
    `);
    const row = r.toArray()[0] as Record<string, number>;
    const { xmin, ymin, xmax, ymax } = row;
    if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // bounds stays null
  }
  return null;
}

export async function runEdgeMatch(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  onProgress: EdgeMatchProgressFn,
  matchColumns: MatchColumnOptions = {},
  passthrough = false,
  fillOptions?: ApplyFillOptions,
  perFeature = false,
): Promise<EdgeMatchResult> {
  onProgress({ phase: "loading" });
  await loadLayers(db, conn, inputFiles, overlayFiles);
  const overlayOutlineGeojson = await tableToGeoJSON(conn, "overlay_layer_01", null);

  onProgress({ phase: "assigning" });
  const assignment = await computeAssignment(conn, matchColumns, passthrough, perFeature);

  const nameGuess = await detectColumns(conn, "overlay_layer_attr");
  const inputColumns = await detectColumns(conn, "input_layer_attr");
  const overlayColumns = nameGuess;
  const groups = await listGroups(conn, nameGuess.name);
  onProgress({ phase: "groups-listed", groups });
  // ge_groups only exists to build the groups list above — nothing later
  // reads it.
  await conn.query("DROP TABLE IF EXISTS ge_groups");

  const groupResults = await runGroups(
    conn,
    groups,
    (groupIndex, groupTotal, group, stage, stageLabel) =>
      onProgress({ phase: "group-stage", groupIndex, groupTotal, group, stage, stageLabel }),
    (groupIndex, groupTotal, result) =>
      onProgress({ phase: "group-done", groupIndex, groupTotal, result }),
  );

  const {
    dropped: droppedCount,
    passthrough: passthroughCount,
    clipEmpty: clipEmptyCount,
  } = await buildIssuesTable(conn);
  const assignedOverlayLabel =
    groups.find((g) => g.overlayFid === assignment.overlayFid)?.label ?? null;

  // A group OOM above leaves the connection poisoned for the rest of the
  // session, so attribute enrichment below may also throw. It's a
  // nice-to-have — fall back to a geometry-only export rather than losing
  // every already-computed group to a downstream error.
  let hasAttrTable = false;
  try {
    // The last group's scratch tables are only cleaned at the *start* of the
    // next runPipeline call, and there is no next call after the loop ends —
    // free them now, before the two heaviest remaining steps.
    await dropInternalTables(conn);

    await buildResultsAttrTable(conn);
    if (fillOptions) await applyOptionalFill(conn, "ge_results_attr", fillOptions);

    // input_layer_attr/ge_unassigned/ge_dropped/ge_issues are deliberately
    // NOT dropped here: DownloadMenu's "unassigned"/"issues" exports read
    // them live, on demand, which can happen well after this function
    // returns.
    await conn.query("DROP TABLE IF EXISTS input_layer_01");
    await conn.query("DROP TABLE IF EXISTS overlay_layer_01");
    await conn.query("DROP TABLE IF EXISTS overlay_layer_attr");
    await conn.query("DROP TABLE IF EXISTS ge_assignment");
    hasAttrTable = true;
  } catch (e) {
    console.warn("Attribute join/scratch cleanup failed, falling back to geometry-only export:", e);
  }
  const attrTable = hasAttrTable ? "ge_results_attr" : null;

  // Export from the already-correct geometry BEFORE attempting the
  // memory-heavy whole-batch CoverageClean pass below — on a large batch it
  // can OOM and poison the connection for the rest of the session, so a
  // clean-then-export order would risk losing an already-correct result.
  let geojson = await tableToGeoJSON(conn, "ge_results", attrTable);
  const bounds = await computeBounds(conn);

  // One whole-batch clean pass, catching cross-group seams no per-group
  // clean could see. Only replaces the export above if it and the re-export
  // both succeed; skipped if the attribute join already failed, since that's
  // a sign the connection is already poisoned.
  let microCount = 0;
  if (hasAttrTable) {
    try {
      await conn.query("DROP TABLE IF EXISTS ge_micro");
      await gatedCoverageClean(conn, "ge_results", { microIssuesTable: "ge_micro" });
      geojson = await tableToGeoJSON(conn, "ge_results", attrTable);
      microCount = await appendMicroIssues(conn);
    } catch (e) {
      console.warn("Output CoverageClean/re-export failed, keeping pre-clean export:", e);
    }
  }

  await runValidation(conn, "ge_results");
  let gapCount = 0;
  try {
    gapCount = await appendGapIssues(conn);
  } catch (e) {
    console.warn("gap issues failed:", e);
  }

  return {
    geojson,
    bounds,
    groupResults,
    unassignedCount: assignment.unassignedCount,
    droppedCount,
    passthroughCount,
    codeMismatchCount: assignment.codeMismatchCount,
    codeFallbackCount: assignment.codeFallbackCount,
    microCount,
    gapCount,
    clipEmptyCount,
    assignedOverlayLabel,
    inputColumns,
    overlayColumns,
    overlayOutlineGeojson,
  };
}
