import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { carryOverlayColumns } from "$lib/db/carryColumns";
import { clipEngine, mergeClipDetached } from "$lib/db/clipEngine";
import { mergeMicroPolygons } from "$lib/db/coverage";
import { changedGeoJSON, tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { buildClipIssues, type ClipIssueRow } from "./issues";
import { loadLayers } from "./load";

export type { ClipIssueRow } from "./issues";

export type ProgressFn = (stage: number, label: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface ClipResult {
  detachedMergedCount: number;
  detachedKeptCount: number;
  inputGeoJSON: string;
  overlayOutlineGeoJSON: string;
  clippedGeoJSON: string;
  changedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  overlayFid: number;
  assignedCount: number;
  overlappingCount: number; // assigned input features overlapping the winner
  emptyClipCount: number; // assigned input features whose clipped result was empty, dropped after clipping
  issues: ClipIssueRow[];
  issuesGeoJSON: string;
  inputColumns: ColumnGuess;
  overlayColumns: ColumnGuess;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ${table} WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    if ([xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))) {
      setCentroidLat((ymin + ymax) / 2);
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Assigns every input feature in the uploaded input layer to the one overlay feature
// that wins a majority vote by count (assign-one, see pipeline/assign.ts),
// then clips each assigned input feature to exactly that overlay feature's geometry
// (pipeline/engine.ts). Ported from topo-tools-py's clip; see
// docs/explanation/edge-clip.md for the scoping difference from Python's general
// multi-file/multi-overlay feature CLI contract.
export async function runClip(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  originalFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
  carryColumns: string[] = [],
): Promise<ClipResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, inputFiles, overlayFiles, originalFiles);
  const inputGeoJSON = await tableToGeoJSON(conn, "input_layer_01", null);
  const overlayOutlineGeoJSON = await tableToGeoJSON(conn, "overlay_layer_01", null);
  const bounds = await computeBounds(conn, "input_layer_01");
  const inputColumns = await detectColumns(conn, "input_layer_attr");
  const overlayColumns = await detectColumns(conn, "overlay_layer_attr");

  onProgress(2, "Assigning to overlay polygon");
  let assign;
  try {
    assign = await assignOne(conn, matchColumns);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }
  if (assign.overlayFid === null) {
    throw new PipelineError(
      "No input polygons overlap any overlay polygon, so there is nothing to clip.",
      2,
    );
  }
  try {
    await carryOverlayColumns(conn, carryColumns, assign.overlayFid, inputColumns.all);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }

  onProgress(3, "Clipping to overlay boundary");
  let engineResult;
  try {
    engineResult = await clipEngine(
      conn,
      "SELECT c.fid, c.geom FROM input_layer_01 c JOIN cl_assign a ON a.input_fid = c.fid",
      `SELECT geom FROM overlay_layer_01 WHERE fid = ${assign.overlayFid}`,
      "cl_clip",
    );
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }
  if (engineResult.outputCount === 0) {
    throw new PipelineError("Clipping produced no output rows.", 3);
  }
  let detached;
  try {
    detached = await mergeClipDetached(conn, assign.overlayFid, originalFiles.length > 0);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }
  try {
    await mergeMicroPolygons(conn, "cl_clip", "cl_clip", "cl_micro");
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }

  const clippedGeoJSON = await tableToGeoJSON(conn, "cl_clip", "input_layer_attr");
  const changed = await changedGeoJSON(conn, "cl_clip", "input_layer_01");

  const { rows: issues, geojson: issuesGeoJSON } = await buildClipIssues(conn, {
    assignmentMethod: assign.assignmentMethod,
    spatialAgrees: assign.spatialAgrees,
  });

  return {
    inputGeoJSON,
    overlayOutlineGeoJSON,
    clippedGeoJSON,
    changedGeoJSON: changed,
    bounds,
    overlayFid: assign.overlayFid,
    detachedMergedCount: detached.merged,
    detachedKeptCount: detached.kept,
    assignedCount: assign.assignedCount,
    overlappingCount: assign.overlappingCount,
    emptyClipCount: engineResult.emptyCount,
    issues,
    issuesGeoJSON,
    inputColumns,
    overlayColumns,
  };
}
