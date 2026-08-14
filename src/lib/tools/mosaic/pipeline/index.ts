import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { clipEngine } from "$lib/db/clipEngine";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
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
  childGeoJSON: string;
  parentOutlineGeoJSON: string;
  mosaicGeoJSON: string;
  bounds: [number, number, number, number] | null;
  parentFid: number;
  issues: MosaicIssueRow[];
  issuesGeoJSON: string;
  hadResidualOverlaps: boolean;
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

// A thin orchestrator chaining assign-one -> clip -> stitch, for a children
// layer that is already a finished Edge Extender output being fit into a
// new/different parent (skips re-running Voronoi extension entirely).
// Ported from topo-tools-py's mosaic; see docs/explanation/mosaic.md for
// the single-children-file scoping this shares with clip (docs/adr/0026).
export async function runMosaic(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  childFiles: File[],
  parentFiles: File[],
  onProgress: ProgressFn,
): Promise<MosaicResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, childFiles, parentFiles);
  const childGeoJSON = await tableToGeoJSON(conn, "child_layer_01", null);
  const parentOutlineGeoJSON = await tableToGeoJSON(conn, "parent_layer_01", null);
  const bounds = await computeBounds(conn, "child_layer_01");

  onProgress(2, "Assigning to parent unit");
  let assign;
  try {
    assign = await assignOne(conn);
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
      "child_layer_attr",
    );
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  onProgress(6, "Assembling issues report");
  const { rows, geojson } = await buildMosaicIssues(conn);

  return {
    childGeoJSON,
    parentOutlineGeoJSON,
    mosaicGeoJSON: stitch.stitchedGeoJSON,
    bounds,
    parentFid: assign.parentFid,
    issues: rows,
    issuesGeoJSON: geojson,
    hadResidualOverlaps: stitch.hadResidualOverlaps,
  };
}
