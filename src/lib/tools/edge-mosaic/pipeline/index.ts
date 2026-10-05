import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { carryOverlayColumns } from "$lib/db/carryColumns";
import { clipEngine, mergeClipDetached } from "$lib/db/clipEngine";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { runStitch } from "../../edge-stitch/pipeline/index";
import { buildMosaicIssues, type MosaicIssueRow } from "./issues";
import { loadLayers } from "./load";

export type { MosaicIssueRow } from "./issues";

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

export interface MosaicResult {
  detachedMergedCount: number;
  detachedKeptCount: number;
  inputGeoJSON: string;
  overlayOutlineGeoJSON: string;
  mosaicGeoJSON: string;
  bounds: [number, number, number, number] | null;
  overlayFid: number;
  issues: MosaicIssueRow[];
  issuesGeoJSON: string;
  hadResidualOverlaps: boolean;
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

// A thin orchestrator chaining assign-one -> clip -> stitch, for an input
// layer that is already a finished Edge Extender output being fit into a
// new/different overlay feature (skips re-running Voronoi extension entirely).
// Ported from topo-tools-py's mosaic; see docs/explanation/edge-mosaic.md for
// the single-input-file scoping this shares with clip (docs/adr/0026).
export async function runMosaic(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  originalFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
  carryColumns: string[] = [],
): Promise<MosaicResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, inputFiles, overlayFiles, originalFiles);
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
  if (assign.overlayFid === null) {
    throw new PipelineError(
      "No input features overlap any overlay feature, so there is nothing to clip.",
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

  // runStitch's own stage numbers (2=Loading input, 3=Closing seams,
  // 4=Checking for residual gaps) are remapped onto mosaic's own stage
  // list; its "Loading input" is suppressed since mosaic already loaded
  // both layers in stage 1. The only step inside runStitch that can throw
  // is "Closing seams" (its own stage 3), remapped to mosaic's stage 4.
  let stitch;
  try {
    stitch = await runStitch(
      conn,
      (stage, label) => {
        if (stage === 3) onProgress(4, label);
        else if (stage === 4) onProgress(5, label);
      },
      "cl_clip",
      "input_layer_attr",
    );
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  onProgress(6, "Assembling issues report");
  const { rows, geojson } = await buildMosaicIssues(conn, {
    assignmentMethod: assign.assignmentMethod,
    spatialAgrees: assign.spatialAgrees,
  });

  return {
    inputGeoJSON,
    overlayOutlineGeoJSON,
    mosaicGeoJSON: stitch.stitchedGeoJSON,
    bounds,
    overlayFid: assign.overlayFid,
    detachedMergedCount: detached.merged,
    detachedKeptCount: detached.kept,
    issues: rows,
    issuesGeoJSON: geojson,
    hadResidualOverlaps: stitch.hadResidualOverlaps,
    inputColumns,
    overlayColumns,
  };
}
