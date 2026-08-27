import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { gatedCoverageClean, hasCoverageViolations } from "$lib/db/coverageClean";
import { hasNoiseFloorGap } from "$lib/db/coverage";
import { tableToGeoJSON } from "$lib/db/geojson";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { dropInternalTables } from "$lib/tools/edge-extender/pipeline/index";
import { loadLayers } from "./load";
import { computeAssignment } from "./assign";
import {
  listGroups,
  PASSTHROUGH_PARENT_FID,
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
  childColumns: ColumnGuess;
  parentColumns: ColumnGuess;
  // Geometry-only outline of the parent input, so the map can show it as a
  // static reference layer alongside the per-group colored result.
  parentOutlineGeojson: string;
}

// Combines every excluded/flagged child (unassigned, dropped-group, and
// code-mismatch/code-fallback per docs/adr/0045) into one exportable table.
async function buildIssuesTable(
  conn: AsyncDuckDBConnection,
): Promise<{ dropped: number; passthrough: number }> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_issues AS
    SELECT 'unassigned-' || fid AS key, 'unassigned' AS kind,
           fid AS unit_a, NULL::BIGINT AS parent_fid, NULL::VARCHAR AS reason, geom
    FROM ge_unassigned
    WHERE fid NOT IN (SELECT child_fid FROM ge_assignment)
    UNION ALL
    SELECT 'dropped_group-' || unit_a AS key, 'dropped_group' AS kind,
           unit_a, parent_fid, reason, geom
    FROM ge_dropped
    UNION ALL
    SELECT 'passthrough-' || ga.child_fid AS key, 'passthrough' AS kind,
           ga.child_fid AS unit_a, ga.parent_fid, NULL::VARCHAR AS reason, c.geom
    FROM ge_assignment ga JOIN child_layer_01 c ON c.fid = ga.child_fid
    WHERE ga.parent_fid = ${PASSTHROUGH_PARENT_FID} AND ga.child_fid IN (SELECT fid FROM ge_results)
    UNION ALL
    SELECT 'code_mismatch-' || a.child_fid AS key, 'code-mismatch' AS kind,
           a.child_fid AS unit_a, a.parent_fid, NULL::VARCHAR AS reason, c.geom
    FROM ge_assignment a JOIN child_layer_01 c ON c.fid = a.child_fid
    WHERE a.assignment_method = 'code' AND a.spatial_agrees = FALSE
    UNION ALL
    SELECT 'code_fallback-' || a.child_fid AS key, 'code-fallback' AS kind,
           a.child_fid AS unit_a, a.parent_fid, NULL::VARCHAR AS reason, c.geom
    FROM ge_assignment a JOIN child_layer_01 c ON c.fid = a.child_fid
    WHERE a.assignment_method = 'spatial_fallback'
  `);
  const [droppedRes, passthroughRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM ge_dropped"),
    conn.query(`SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'passthrough'`),
  ]);
  return {
    dropped: Number((droppedRes.toArray()[0] as { n: bigint | number }).n),
    passthrough: Number((passthroughRes.toArray()[0] as { n: bigint | number }).n),
  };
}

async function buildResultsAttrTable(conn: AsyncDuckDBConnection): Promise<void> {
  const parentDesc = await conn.query("DESCRIBE parent_layer_attr");
  const parentCols = (parentDesc.toArray() as Array<{ column_name: string }>)
    .map((r) => r.column_name)
    .filter((c) => c !== "fid");
  // Parent attribute columns are prefixed to avoid silently colliding with
  // (and shadowing) a child-layer column of the same name in the SELECT *.
  const parentExprs = parentCols.map(
    (c) => `ca.${JSON.stringify(c)} AS ${JSON.stringify(`parent_${c}`)}`,
  );
  const parentSelect = parentExprs.length > 0 ? ", " + parentExprs.join(", ") : "";

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_results_attr AS
    SELECT fa.*, ga.parent_fid AS group_id${parentSelect}
    FROM child_layer_attr fa
    JOIN ge_assignment ga ON ga.child_fid = fa.fid
    LEFT JOIN parent_layer_attr ca ON ca.fid = ga.parent_fid
  `);
}

// Warn-only topology check on the final assembled output, matching
// edge-extender's own runValidation pattern — but tolerant at SNAP_TOLERANCE
// (hasNoiseFloorGap), not zero-tolerance: unlike extend, match clips against
// a parent/clip layer whose own shape can have a real, legitimate interior
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
  childFiles: File[],
  parentFiles: File[],
  onProgress: EdgeMatchProgressFn,
  matchColumns: MatchColumnOptions = {},
  passthrough = false,
): Promise<EdgeMatchResult> {
  onProgress({ phase: "loading" });
  await loadLayers(db, conn, childFiles, parentFiles);
  const parentOutlineGeojson = await tableToGeoJSON(conn, "parent_layer_01", null);

  onProgress({ phase: "assigning" });
  const assignment = await computeAssignment(conn, matchColumns, passthrough);

  const nameGuess = await detectColumns(conn, "parent_layer_attr");
  const childColumns = await detectColumns(conn, "child_layer_attr");
  const parentColumns = nameGuess;
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

  const { dropped: droppedCount, passthrough: passthroughCount } = await buildIssuesTable(conn);

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

    // child_layer_attr/ge_unassigned/ge_dropped/ge_issues are deliberately
    // NOT dropped here: DownloadMenu's "unassigned"/"issues" exports read
    // them live, on demand, which can happen well after this function
    // returns.
    await conn.query("DROP TABLE IF EXISTS child_layer_01");
    await conn.query("DROP TABLE IF EXISTS parent_layer_01");
    await conn.query("DROP TABLE IF EXISTS parent_layer_attr");
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
  if (hasAttrTable) {
    try {
      await gatedCoverageClean(conn, "ge_results");
      geojson = await tableToGeoJSON(conn, "ge_results", attrTable);
    } catch (e) {
      console.warn("Output CoverageClean/re-export failed, keeping pre-clean export:", e);
    }
  }

  await runValidation(conn, "ge_results");

  return {
    geojson,
    bounds,
    groupResults,
    unassignedCount: assignment.unassignedCount,
    droppedCount,
    passthroughCount,
    codeMismatchCount: assignment.codeMismatchCount,
    codeFallbackCount: assignment.codeFallbackCount,
    childColumns,
    parentColumns,
    parentOutlineGeojson,
  };
}
