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

  // The last group's own runPipeline call only cleans its scratch tables
  // (layer_04, layer_05_tmp1/2, layer_03a, etc.) at the *start* of the next
  // call — there is no next call after the loop ends, so they'd otherwise
  // linger through the two heaviest remaining steps below (whole-batch
  // CoverageClean and the final GeoJSON export), right when peak memory
  // matters most. (Measured on a real 43-group/465-feature batch: this alone
  // is not sufficient to avoid the OOM below — the scratch tables from just
  // the last group are small — but it's free, correct, and still worth doing.)
  await dropInternalTables(conn);

  await buildResultsAttrTable(conn);

  // child_layer_01/parent_layer_01/parent_layer_attr/ge_assignment were all
  // needed throughout the per-group loop above (population, clip target,
  // parent attribute join) and by buildResultsAttrTable just above (the last
  // reader of parent_layer_attr and ge_assignment) — nothing downstream reads
  // any of them again. child_layer_attr and ge_unassigned are deliberately
  // NOT dropped here: DownloadMenu's "unassigned" export reads both live,
  // on demand, whenever the user clicks it, which can happen well after this
  // function returns.
  await conn.query("DROP TABLE IF EXISTS child_layer_01");
  await conn.query("DROP TABLE IF EXISTS parent_layer_01");
  await conn.query("DROP TABLE IF EXISTS parent_layer_attr");
  await conn.query("DROP TABLE IF EXISTS ge_assignment");

  // Export from the already-correct, already-verified geometry BEFORE
  // attempting the memory-heavy whole-batch CoverageClean pass below.
  // ST_CoverageClean's WASM-GEOS implementation has known robustness edges
  // (docs/performance.md) and on a large assembled batch can exceed the
  // WASM heap's ~3GiB ceiling. `gatedCoverageClean` itself catches that and
  // leaves `ge_results` untouched, but WASM linear memory can't shrink back
  // down once grown — confirmed empirically that once the clean OOMs, even a
  // trivial subsequent query fails to commit for the rest of the session. If
  // clean-then-export were the order, a clean failure would silently take
  // the whole, already-correct 43-group result down with it. Exporting first
  // means the worst case is "not perfectly seamless" instead of "nothing at
  // all" — ge_results without this clean is still a fully valid result (every
  // fid clipped to its own parent boundary), just with possible micro seams
  // at group boundaries that a per-group clean couldn't see.
  let geojson = await tableToGeoJSON(conn, "ge_results", "ge_results_attr");
  const bounds = await computeBounds(conn);

  // The one and only coverage-clean pass for the whole batch, run here on
  // the fully assembled result rather than per-group inside runGroups —
  // per-group cleaning would be redundant (this table gets reshaped again
  // by each group's clip step before this point exists) and this single
  // pass also catches cross-group seams that no per-group clean could see
  // in the first place, since adjacent groups never share table state. Only
  // replace the export above if both the clean and the re-export succeed.
  try {
    await gatedCoverageClean(conn, "ge_results", { gap: OUTPUT_CLEAN_GAP });
    geojson = await tableToGeoJSON(conn, "ge_results", "ge_results_attr");
  } catch (e) {
    console.warn("Output CoverageClean/re-export failed, keeping pre-clean export:", e);
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
