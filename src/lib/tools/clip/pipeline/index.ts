import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { clipEngine } from "$lib/db/clipEngine";
import { tableToGeoJSON } from "$lib/db/geojson";
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
  inputGeoJSON: string;
  overlayOutlineGeoJSON: string;
  clippedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  overlayFid: number;
  assignedCount: number;
  droppedAssignCount: number; // input features that didn't overlap the winner overlay feature, dropped before clipping
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
// docs/explanation/clip.md for the scoping difference from Python's general
// multi-file/multi-overlay feature CLI contract.
export async function runClip(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
): Promise<ClipResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, inputFiles, overlayFiles);
  const inputGeoJSON = await tableToGeoJSON(conn, "input_layer_01", null);
  const overlayOutlineGeoJSON = await tableToGeoJSON(conn, "overlay_layer_01", null);
  const bounds = await computeBounds(conn, "input_layer_01");
  const inputColumns = await detectColumns(conn, "input_layer_attr");
  const overlayColumns = await detectColumns(conn, "overlay_layer_attr");

  onProgress(2, "Assigning to overlay feature");
  let assign;
  try {
    assign = await assignOne(conn, matchColumns);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }

  onProgress(3, "Clipping to overlay boundary");
  let engineResult;
  try {
    engineResult = await clipEngine(conn, assign.overlayFid);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }
  if (engineResult.outputCount === 0) {
    throw new PipelineError("Clipping produced no output rows.", 3);
  }

  const clippedGeoJSON = await tableToGeoJSON(conn, "cl_clip", "input_layer_attr");

  const { rows: issues, geojson: issuesGeoJSON } = await buildClipIssues(conn, {
    assignmentMethod: assign.assignmentMethod,
    spatialAgrees: assign.spatialAgrees,
  });

  return {
    inputGeoJSON,
    overlayOutlineGeoJSON,
    clippedGeoJSON,
    bounds,
    overlayFid: assign.overlayFid,
    assignedCount: assign.assignedCount,
    droppedAssignCount: assign.droppedCount,
    emptyClipCount: engineResult.emptyCount,
    issues,
    issuesGeoJSON,
    inputColumns,
    overlayColumns,
  };
}
