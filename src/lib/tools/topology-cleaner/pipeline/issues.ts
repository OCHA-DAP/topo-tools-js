import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import {
  assembleIssues,
  buildGapRegions as sharedBuildGapRegions,
  buildOverlapRegions as sharedBuildOverlapRegions,
  type IssueKind,
  type IssueRow,
  type IssuesResult,
} from "$lib/db/issues";
import { degSqToM2, degToM } from "$lib/db/units";
import { niceNum } from "./units";

export type { IssueKind, IssueRow, IssuesResult } from "$lib/db/issues";

// Polsby-Popper compactness cutoff (4·π·Area / Perimeter², 1.0 = circle,
// →0 = elongated crack) below which a gap is treated as a digitization
// sliver rather than a real feature. Same formula and cutoff guidance
// ArcGIS Pro's "Polygon Sliver" data-quality check uses. Not user-tunable —
// see resolveGapFillWidths.
const DEFAULT_THINNESS_RATIO = 0.3;

// Headroom over the widest qualifying gap's width in Thin mode, so that gap
// reliably clears ST_CoverageClean's internal <= width comparison — just
// enough, not "2x and round," to avoid also sweeping in a wider, non-thin
// gap Thin wasn't meant to touch (ST_CoverageClean only understands width,
// not thinness). Matches topo-tools-py's current tuning
// (AUTO_GAP_WIDTH_EPSILON_FACTOR, widened from 1.001 to 1.01 after real-data
// testing).
const AUTO_GAP_WIDTH_EPSILON_FACTOR = 1.01;

// A discrete topology problem in the *input* coverage, surfaced in the issues
// table so the user can click to zoom to it. Gaps and overlaps are computed once
// at load (a property of the input). Region detection + issue-row assembly are
// shared with detect (see $lib/db/issues) — this file adds only what's
// specific to a reclean loop: persisted fixed-status tracking and the
// gap-fill-mode width resolution the Minimal/Thin/All UI needs.

export async function buildGapRegions(conn: AsyncDuckDBConnection): Promise<boolean> {
  return sharedBuildGapRegions(conn, "tc_gap_regions", "layer_01");
}

export async function buildOverlapRegions(
  conn: AsyncDuckDBConnection,
  hasViolations = true,
): Promise<boolean> {
  return sharedBuildOverlapRegions(conn, "tc_overlap_regions", "layer_01", hasViolations);
}

// Assemble the issues table/rows/geojson from the gap + overlap region tables,
// which are inputs built once per load by runFromLoaded.
export async function buildIssues(
  conn: AsyncDuckDBConnection,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  return assembleIssues(
    conn,
    { issuesTable: "tc_issues", gapRegionsTable: "tc_gap_regions", overlapRegionsTable: "tc_overlap_regions" },
    failedKinds,
  );
}

// Check which issues are resolved in the current cleaned output (tc_clean),
// persisting the result into tc_issues.fixed so it survives into any export
// (see export.ts's topology_issues columns) rather than living only in this
// function's return value. Overlaps are always fixed by ST_CoverageClean. For
// gaps, we test whether a representative interior point of the gap polygon is
// now covered by any cleaned polygon — if so, the gap has been merged into a
// neighbour.
//
// Also persists outcome columns (measured after the fix, not detection-time
// values) matching topo-tools-py's issues-file schema: unit_a/b_area_change_m2
// (an overlap-adjacent unit's own area delta) and filled_area_m2 (how much of
// a gap the cleaned coverage now actually fills, 0 if unfilled).
export async function checkFixedIssues(
  conn: AsyncDuckDBConnection,
  rows: IssueRow[],
): Promise<Set<string>> {
  const fixed = new Set<string>();
  rows.filter((r) => r.kind === "overlap").forEach((r) => fixed.add(r.key));
  const areaFactor = degSqToM2(1).toExponential();

  try {
    await conn.query(`--sql
      UPDATE tc_issues SET
        fixed = (kind = 'overlap'),
        unit_a_area_change_m2 = (
          COALESCE((SELECT ST_Area(geom) FROM tc_clean WHERE fid = tc_issues.unit_a), 0)
          - COALESCE((SELECT ST_Area(geom) FROM layer_01 WHERE fid = tc_issues.unit_a), 0)
        ) * ${areaFactor},
        unit_b_area_change_m2 = (
          COALESCE((SELECT ST_Area(geom) FROM tc_clean WHERE fid = tc_issues.unit_b), 0)
          - COALESCE((SELECT ST_Area(geom) FROM layer_01 WHERE fid = tc_issues.unit_b), 0)
        ) * ${areaFactor}
      WHERE kind = 'overlap'
    `);
  } catch (e) {
    console.warn("checkFixedIssues: persisting overlap fixed status failed:", e);
  }

  const hasGaps = rows.some((r) => r.kind === "gap");
  if (!hasGaps) return fixed;

  try {
    await conn.query(`--sql
      UPDATE tc_issues SET fixed = EXISTS (
        SELECT 1 FROM tc_clean c WHERE ST_Contains(c.geom, ST_PointOnSurface(tc_issues.geom))
      )
      WHERE kind = 'gap'
    `);
    await conn.query(`--sql
      UPDATE tc_issues
      SET filled_area_m2 = ST_Area(ST_Intersection(tc_issues.geom, u.geom)) * ${areaFactor}
      FROM (
        SELECT ST_Union_Agg(geom) AS geom FROM tc_clean
        WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ) AS u
      WHERE tc_issues.kind = 'gap'
    `);
    const result = await conn.query(`SELECT key FROM tc_issues WHERE kind = 'gap' AND fixed`);
    for (const row of result.toArray() as Array<{ key: string }>) {
      fixed.add(row.key);
    }
  } catch (e) {
    console.warn("checkFixedIssues failed; fixed status unavailable:", e);
  }

  return fixed;
}

// Derive the gap-fill widths the UI's Minimal/Thin/All modes need.
//
// Minimal (the default) only considers gaps at or below SNAP_TOLERANCE —
// floating-point-noise scale, never a real feature — and fills them at
// exactly that width. Matches topo-tools-py's own default (no shape
// heuristic; ADR-0033/0034).
//
// Thin (topo-tools-py's "thin", formerly this UI's default "Auto") only
// considers gaps shaped like a digitization sliver
// (thinnessRatio <= DEFAULT_THINNESS_RATIO), and uses just enough headroom
// over the widest one (AUTO_GAP_WIDTH_EPSILON_FACTOR) to reliably clear it —
// not "2x and round," which would risk also filling a wider, non-thin gap
// Thin wasn't meant to touch.
//
// sliderCeilingM ("2x the widest detected gap, rounded up to a nice number")
// is UI-only: it sizes the Manual slider's max/step and All mode's display
// text. All mode's actual fill width is topo-tools-py's fixed
// GAP_MAXIMUM_WIDTH_ALL_DEG sentinel (applied directly in pipeline/index.ts),
// not derived from this number — a looser bound changes no outcome for All
// regardless, since it already fills every detected gap.
//
// Any of these can be 0 (no qualifying gaps), meaning "fill nothing."
export function resolveGapFillWidths(rows: IssueRow[]): {
  sliderCeilingM: number;
  thinFillM: number;
  minimalFillM: number;
} {
  const widthsOf = (predicate: (r: IssueRow) => boolean) =>
    rows.filter((r) => r.kind === "gap" && r.maxWidthM > 0 && predicate(r)).map((r) => r.maxWidthM);
  const allWidths = widthsOf(() => true);
  const thinWidths = widthsOf((r) => (r.thinnessRatio ?? 1) <= DEFAULT_THINNESS_RATIO);
  const snapToleranceM = degToM(SNAP_TOLERANCE);
  const hasNoiseScaleGap = widthsOf((r) => r.maxWidthM <= snapToleranceM).length > 0;
  return {
    sliderCeilingM: allWidths.length ? niceNum(Math.max(...allWidths) * 2) : 0,
    thinFillM: thinWidths.length ? Math.max(...thinWidths) * AUTO_GAP_WIDTH_EPSILON_FACTOR : 0,
    minimalFillM: hasNoiseScaleGap ? snapToleranceM : 0,
  };
}
