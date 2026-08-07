import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { gatedCoverageClean } from "$lib/db/coverageClean";
import { tableToGeoJSON } from "$lib/db/geojson";
import { detectColumns } from "$lib/db/columns";
import type { OverlapMethod } from "$lib/db/overlap";
import { dropInternalTables, OUTPUT_CLEAN_GAP } from "$lib/tools/edge-extender/pipeline/index";
import { loadLayers } from "./load";
import { computeAssignment } from "./assign";
import { listGroups, runGroups, type GroupInfo, type GroupResult } from "./groups";

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
  method: OverlapMethod;
  groupResults: GroupResult[];
  unassignedCount: number;
  // Geometry-only outline of the parent input, so the map can show it as a
  // static reference layer alongside the per-group colored result.
  parentOutlineGeojson: string;
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
): Promise<EdgeMatchResult> {
  onProgress({ phase: "loading" });
  await loadLayers(db, conn, childFiles, parentFiles);
  const parentOutlineGeojson = await tableToGeoJSON(conn, "parent_layer_01", null);

  onProgress({ phase: "assigning" });
  const assignment = await computeAssignment(conn);

  const nameGuess = await detectColumns(conn, "parent_layer_attr");
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

    // child_layer_attr/ge_unassigned are deliberately NOT dropped here:
    // DownloadMenu's "unassigned" export reads both live, on demand, which
    // can happen well after this function returns.
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
      await gatedCoverageClean(conn, "ge_results", { gap: OUTPUT_CLEAN_GAP });
      geojson = await tableToGeoJSON(conn, "ge_results", attrTable);
    } catch (e) {
      console.warn("Output CoverageClean/re-export failed, keeping pre-clean export:", e);
    }
  }

  return {
    geojson,
    bounds,
    method: assignment.method,
    groupResults,
    unassignedCount: assignment.unassignedCount,
    parentOutlineGeojson,
  };
}
