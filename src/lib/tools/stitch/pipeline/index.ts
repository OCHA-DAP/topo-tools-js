import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean, hasCoverageViolations } from "$lib/db/coverageClean";
import { hasNoiseFloorGap } from "$lib/db/coverage";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { buildStitchIssues, type StitchIssueRow } from "./issues";

export type { StitchIssueRow } from "./issues";

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

export interface StitchResult {
  originalGeoJSON: string;
  stitchedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  issues: StitchIssueRow[];
  issuesGeoJSON: string;
  // ST_CoverageClean should remove every overlap by construction; true here
  // means it didn't (logged as a warning, matches extend/match's warn-only
  // validation — see edge-extender/pipeline/index.ts's runValidation).
  hadResidualOverlaps: boolean;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ${sourceTable} WHERE geom IS NOT NULL
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

// Close seams in an already-tiled sourceTable/attrTable with one whole-table
// ST_CoverageClean pass, at SNAP_TOLERANCE gap/snap (topo-tools-py's
// stitch default, ADR-0040) — not the shape-based heuristics clean's
// Minimal/Thin/All modes use, since stitch has no user-facing gap-width
// control. preserveOriginal: true, matching topo-tools-py's coverage_clean
// (every input row survives into the output; see docs/explanation/stitch.md).
// sourceTable/attrTable default to stitch's own standard-loaded input
// (layer_01/layer_attr); mosaic calls this directly against its own
// already-clipped table (see docs/explanation/mosaic.md).
export async function runStitch(
  conn: AsyncDuckDBConnection,
  onProgress: ProgressFn,
  sourceTable = "layer_01",
  attrTable = "layer_attr",
): Promise<StitchResult> {
  onProgress(2, "Loading input");
  const bounds = await computeBounds(conn, sourceTable);
  const originalGeoJSON = await tableToGeoJSON(conn, sourceTable, null);

  onProgress(3, "Closing seams");
  try {
    await buildCoverageClean(conn, sourceTable, "st_clean", {
      gap: SNAP_TOLERANCE,
      preserveOriginal: true,
    });
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }

  onProgress(4, "Checking for residual gaps");
  const hadResidualOverlaps = await hasCoverageViolations(conn, "st_clean");
  if (hadResidualOverlaps) {
    console.warn("stitch: overlaps remain in st_clean after ST_CoverageClean");
  }

  // A gap at or below the noise floor surviving the clean pass above (which
  // was itself run with gap=SNAP_TOLERANCE) means the fill silently failed —
  // an unambiguous bug signal, distinct from buildStitchIssues' report of
  // wider (possibly legitimate) gaps below.
  if (await hasNoiseFloorGap(conn, "st_clean")) {
    console.warn("stitch: a noise-floor gap remains in st_clean after ST_CoverageClean");
  }

  const { rows, geojson } = await buildStitchIssues(conn, "st_clean");
  if (rows.length > 0) {
    console.warn(
      `stitch: ${rows.length} gap(s) wider than the noise floor remain in the output ` +
        "(may be a legitimate unfilled gap, not a defect), see the issues download",
    );
  }

  const stitchedGeoJSON = await tableToGeoJSON(conn, "st_clean", attrTable);

  return {
    originalGeoJSON,
    stitchedGeoJSON,
    bounds,
    issues: rows,
    issuesGeoJSON: geojson,
    hadResidualOverlaps,
  };
}
