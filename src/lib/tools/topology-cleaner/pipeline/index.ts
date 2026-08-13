import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { buildClean, buildInput, countRows, inputHasViolations } from "./clean";
import {
  buildGapRegions,
  buildIssues,
  buildOverlapRegions,
  checkFixedIssues,
  resolveGapFillWidths,
  type IssueKind,
  type IssueRow,
} from "./issues";
import { GAP_MAXIMUM_WIDTH_ALL_DEG, metersToDegrees } from "./units";
import { verifyExport, type ExportCheck } from "./verify";

export type { IssueKind, IssueRow } from "./issues";
export { resolveGapFillWidths } from "./issues";
export type { ExportCheck } from "./verify";

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

export interface CleanOptions {
  gapWidthM: number; // primary slider, meters (0 = no gap filling)
  // True when the UI's All mode is active: fills every detected gap via the
  // fixed GAP_MAXIMUM_WIDTH_ALL_DEG sentinel instead of gapWidthM's meters value.
  allGaps?: boolean;
}

export interface CleanResult {
  originalGeoJSON: string;
  cleanedGeoJSON: string;
  issues: IssueRow[];
  issuesGeoJSON: string;
  bounds: [number, number, number, number] | null;
  totalCount: number;
  collapsedCount: number;
  fixedKeys: Set<string>;
  // Kinds whose detection query failed (even after retry) and was degraded to
  // an empty table — a 0 count for these means "couldn't check," not "clean."
  detectionFailed: Set<IssueKind>;
  // Independent validation of the exact table that gets exported (tc_clean),
  // run automatically on every clean/reclean. See verify.ts.
  exportCheck: ExportCheck;
}

export interface RecleanResult {
  cleanedGeoJSON: string;
  collapsedCount: number;
  fixedKeys: Set<string>;
  issues: IssueRow[];
  issuesGeoJSON: string;
  detectionFailed: Set<IssueKind>;
  exportCheck: ExportCheck;
}

// Carried from the full run to cheap re-runs. Gap/overlap detection is static
// (built once per load, independent of the gap-width slider), so the issues
// table, its GeoJSON, and its failure state are all cached here and reused
// as-is by every reclean.
let totalCount = 0;
let cachedIssues: IssueRow[] = [];
let cachedIssuesGeoJSON = "";
let cachedFailedKinds = new Set<IssueKind>();
// layer_01 is static per load, so its violations check (see clean.ts's
// buildClean skip-gate) is computed once in runFromLoaded and reused by every
// reclean instead of re-running ST_CoverageInvalidEdges_Agg on every slider drag.
let cachedHasViolations = true;

async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM layer_01 WHERE geom IS NOT NULL
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

// Re-clean at the current gap-fill mode (gapWidthM for Minimal/Thin/Manual,
// allGaps for All — see CleanOptions). Snapping tolerance is runCoverageClean's
// own SNAP_TOLERANCE default. Gap + overlap regions and the issues table are
// static (built once per load) and are NOT recomputed here.
export async function recleanOnly(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult> {
  const gapDeg = opts.allGaps ? GAP_MAXIMUM_WIDTH_ALL_DEG : metersToDegrees(opts.gapWidthM);

  await buildClean(conn, "tc_clean", gapDeg, cachedHasViolations);
  const kept = await countRows(conn, "tc_clean");

  const fixedKeys = await checkFixedIssues(conn, cachedIssues);
  const exportCheck = await verifyExport(conn);

  return {
    cleanedGeoJSON: await tableToGeoJSON(conn, "tc_clean", "layer_attr"),
    collapsedCount: Math.max(0, totalCount - kept),
    fixedKeys,
    issues: cachedIssues,
    issuesGeoJSON: cachedIssuesGeoJSON,
    detectionFailed: cachedFailedKinds,
    exportCheck,
  };
}

// Full run from already-loaded layer_01/layer_attr: freeze the input, enumerate
// issues (gaps + overlaps), then clean at a gap width auto-derived from the
// widest detected gap.
export async function runFromLoaded(
  conn: AsyncDuckDBConnection,
  onProgress: ProgressFn,
): Promise<CleanResult> {
  onProgress(2, "Analyzing coverage");
  totalCount = await buildInput(conn);
  if (totalCount === 0) {
    throw new PipelineError("No polygons found to clean.", 2);
  }
  cachedHasViolations = await inputHasViolations(conn);

  const bounds = await computeBounds(conn);
  const originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);

  onProgress(3, "Finding gaps & overlaps");
  // Region tables: gaps + overlaps are a property of the input, built once.
  // Best-effort — failures degrade to an empty region table, never abort the
  // clean (their failure state is recorded instead).
  const gapOk = await buildGapRegions(conn);
  const overlapOk = await buildOverlapRegions(conn, cachedHasViolations);
  const failedKinds = new Set<IssueKind>();
  if (!gapOk) failedKinds.add("gap");
  if (!overlapOk) failedKinds.add("overlap");

  onProgress(4, "Fixing topology");
  // Assemble issues (gap widths via ST_MaximumInscribedCircle), then run a
  // single ST_CoverageClean at the Minimal-mode gap width (noise-scale gaps
  // only) — the UI's default mode, so the first clean a user sees matches it.
  let cleanedGeoJSON: string;
  let collapsedCount: number;
  let fixedKeys: Set<string>;
  let exportCheck: ExportCheck;
  try {
    const issuesRes = await buildIssues(conn, failedKinds);
    cachedIssues = issuesRes.rows;
    cachedIssuesGeoJSON = issuesRes.geojson;
    cachedFailedKinds = issuesRes.failedKinds;

    const { minimalFillM } = resolveGapFillWidths(issuesRes.rows);

    await buildClean(conn, "tc_clean", metersToDegrees(minimalFillM), cachedHasViolations);

    const kept = await countRows(conn, "tc_clean");
    fixedKeys = await checkFixedIssues(conn, cachedIssues);
    exportCheck = await verifyExport(conn);
    cleanedGeoJSON = await tableToGeoJSON(conn, "tc_clean", "layer_attr");
    collapsedCount = Math.max(0, totalCount - kept);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  return {
    originalGeoJSON,
    cleanedGeoJSON,
    issues: cachedIssues,
    issuesGeoJSON: cachedIssuesGeoJSON,
    bounds,
    totalCount,
    collapsedCount,
    fixedKeys,
    detectionFailed: cachedFailedKinds,
    exportCheck,
  };
}
