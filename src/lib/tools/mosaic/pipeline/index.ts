import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { clipEngine } from "$lib/db/clipEngine";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import type { ApplyFillOptions } from "$lib/db/fillCompose";
import { runStitch } from "../../stitch/pipeline/index";
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
// Ported from topo-tools-py's mosaic; see docs/explanation/mosaic.md for
// the single-input-file scoping this shares with clip (docs/adr/0026).
export async function runMosaic(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
  carryOverlayColumns: string[] = [],
  fillOptions?: ApplyFillOptions,
): Promise<MosaicResult> {
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

  // Ported from topo-tools-py's carry_columns: joins the single winning
  // overlay feature's own attribute values onto every output row.
  if (carryOverlayColumns.length > 0) {
    const selectCols = carryOverlayColumns
      .map((c) => `p.${JSON.stringify(c)} AS ${JSON.stringify(`overlay_${c}`)}`)
      .join(", ");
    await conn.query(`--sql
      CREATE OR REPLACE TABLE input_layer_attr AS
      SELECT c.*, ${selectCols}
      FROM input_layer_attr c, (SELECT * FROM overlay_layer_attr WHERE fid = ${assign.overlayFid}) p
    `);
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
      fillOptions,
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
    issues: rows,
    issuesGeoJSON: geojson,
    hadResidualOverlaps: stitch.hadResidualOverlaps,
    inputColumns,
    overlayColumns,
  };
}
