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
  childGeoJSON: string;
  parentOutlineGeoJSON: string;
  clippedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  parentFid: number;
  assignedCount: number;
  droppedAssignCount: number; // children that didn't overlap the winner parent, dropped before clipping
  emptyClipCount: number; // assigned children whose clipped result was empty, dropped after clipping
  issues: ClipIssueRow[];
  issuesGeoJSON: string;
  childColumns: ColumnGuess;
  parentColumns: ColumnGuess;
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

// Assigns every child in the uploaded children layer to the one parent unit
// that wins a majority vote by count (assign-one, see pipeline/assign.ts),
// then clips each assigned child to exactly that parent's geometry
// (pipeline/engine.ts). Ported from topo-tools-py's clip; see
// docs/explanation/clip.md for the scoping difference from Python's general
// multi-file/multi-parent CLI contract.
export async function runClip(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  childFiles: File[],
  parentFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
): Promise<ClipResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, childFiles, parentFiles);
  const childGeoJSON = await tableToGeoJSON(conn, "child_layer_01", null);
  const parentOutlineGeoJSON = await tableToGeoJSON(conn, "parent_layer_01", null);
  const bounds = await computeBounds(conn, "child_layer_01");
  const childColumns = await detectColumns(conn, "child_layer_attr");
  const parentColumns = await detectColumns(conn, "parent_layer_attr");

  onProgress(2, "Assigning to parent unit");
  let assign;
  try {
    assign = await assignOne(conn, matchColumns);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }

  onProgress(3, "Clipping to parent boundary");
  let engineResult;
  try {
    engineResult = await clipEngine(conn, assign.parentFid);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }
  if (engineResult.outputCount === 0) {
    throw new PipelineError("Clipping produced no output rows.", 3);
  }

  const clippedGeoJSON = await tableToGeoJSON(conn, "cl_clip", "child_layer_attr");

  const { rows: issues, geojson: issuesGeoJSON } = await buildClipIssues(conn, {
    assignmentMethod: assign.assignmentMethod,
    spatialAgrees: assign.spatialAgrees,
  });

  return {
    childGeoJSON,
    parentOutlineGeoJSON,
    clippedGeoJSON,
    bounds,
    parentFid: assign.parentFid,
    assignedCount: assign.assignedCount,
    droppedAssignCount: assign.droppedCount,
    emptyClipCount: engineResult.emptyCount,
    issues,
    issuesGeoJSON,
    childColumns,
    parentColumns,
  };
}
