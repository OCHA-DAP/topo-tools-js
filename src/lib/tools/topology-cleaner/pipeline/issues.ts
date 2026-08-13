import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { emptyRegions, gapRegionsQuery, overlapRegionsQuery } from "$lib/db/coverage";
import { degSqToM2, degToM, niceNum } from "./units";

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
// at load (a property of the input).

export interface IssueRow {
  key: string; // "gap-3" / "overlap-7" — stable id, also the map feature id
  kind: "gap" | "overlap";
  areaM2: number; // approximate, for display/sorting
  maxWidthM: number; // Maximum Inscribed Circle diameter, approximate
  thinnessRatio: number | null; // Polsby-Popper compactness; gap rows only, null for overlaps
  units: number[]; // fids involved (overlaps: two units; gaps: none)
  bbox: [number, number, number, number];
}

export type IssueKind = "gap" | "overlap";

export interface IssuesResult {
  rows: IssueRow[];
  geojson: string; // FeatureCollection of issue polygons, props {key, kind}
  // Kinds whose detection query threw and was degraded to an empty table — a
  // 0 count for these is NOT "clean", it's "couldn't check." Distinct from a
  // kind that ran fine and found nothing.
  failedKinds: Set<IssueKind>;
}

// Degrades to an empty table on GEOS overlay failure. Returns false when that
// happens — the caller surfaces this so the UI can tell "detection failed"
// apart from "genuinely 0 gaps."
export async function buildGapRegions(conn: AsyncDuckDBConnection): Promise<boolean> {
  try {
    await conn.query(gapRegionsQuery("tc_gap_regions", "layer_01"));
    return true;
  } catch (e) {
    console.warn("gap-region detection failed; skipping gaps:", e);
    await emptyRegions(conn, "tc_gap_regions");
    return false;
  }
}

// Degrades to an empty table on GEOS overlay failure. Returns false when that
// happens. Skips the O(n²) self-join entirely when the input already has no
// coverage violations — a coverage with no invalid edges cannot contain an
// overlapping or nested pair either, matching topo-tools-py's
// has_coverage_violations() pre-check (confirmed there to cut a ~20min run on
// an already-clean 9,658-fid layer to ~23s, dominated by gap detection).
export async function buildOverlapRegions(
  conn: AsyncDuckDBConnection,
  hasViolations = true,
): Promise<boolean> {
  if (!hasViolations) {
    await emptyRegions(conn, "tc_overlap_regions", ", NULL::BIGINT AS fa, NULL::BIGINT AS fb");
    return true;
  }
  try {
    await conn.query(overlapRegionsQuery("tc_overlap_regions", "layer_01"));
    return true;
  } catch (e) {
    console.warn("overlap detection failed; skipping overlaps:", e);
    await emptyRegions(conn, "tc_overlap_regions", ", NULL::BIGINT AS fa, NULL::BIGINT AS fb");
    return false;
  }
}

// Assemble the issues table/rows/geojson from the gap + overlap region tables,
// which are inputs built once per load by runFromLoaded.
export async function buildIssues(
  conn: AsyncDuckDBConnection,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  return assembleIssues(conn, failedKinds);
}

// Union the two region tables into tc_issues and derive the table rows + map
// GeoJSON. Assumes tc_gap_regions / tc_overlap_regions exist.
async function assembleIssues(
  conn: AsyncDuckDBConnection,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  // Linear scalings (degSqToM2(x) = x * areaFactor, degToM(x) = x * widthFactor) —
  // compute the factor once here so the conversion formula itself stays defined
  // only in units.ts, with SQL just receiving the literal multiplier.
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_issues AS
    SELECT key, kind, area_deg, mic_radius_deg,
           area_deg * ${areaFactor} AS area_m2,
           mic_radius_deg * 2 * ${widthFactor} AS max_width_m,
           thinness_ratio,
           FALSE AS fixed,
           NULL::DOUBLE AS filled_area_m2,
           NULL::DOUBLE AS unit_a_area_change_m2,
           NULL::DOUBLE AS unit_b_area_change_m2,
           unit_a, unit_b, geom, xmin, ymin, xmax, ymax
    FROM (
      SELECT 'gap-' || n AS key, 'gap' AS kind, ST_Area(geom) AS area_deg,
             (ST_MaximumInscribedCircle(geom)).radius AS mic_radius_deg,
             4 * pi() * ST_Area(geom) / POWER(ST_Perimeter(geom), 2) AS thinness_ratio,
             NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b, geom,
             ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
      FROM tc_gap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      UNION ALL
      SELECT 'overlap-' || n, 'overlap', ST_Area(geom),
             (ST_MaximumInscribedCircle(geom)).radius,
             NULL::DOUBLE,
             fa, fb, geom,
             ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)
      FROM tc_overlap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    ) t
  `);

  const meta = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, unit_b, xmin, ymin, xmax, ymax
    FROM tc_issues
    ORDER BY
      CASE kind WHEN 'overlap' THEN 0 ELSE 1 END,
      CASE kind WHEN 'overlap' THEN -max_width_m ELSE max_width_m END
  `);
  const rows: IssueRow[] = (
    meta.toArray() as Array<{
      key: string;
      kind: "gap" | "overlap";
      area_m2: number | null;
      max_width_m: number | null;
      thinness_ratio: number | null;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
    }>
  ).map((r) => ({
    key: r.key,
    kind: r.kind,
    areaM2: r.area_m2 ?? NaN,
    maxWidthM: r.max_width_m ?? NaN,
    thinnessRatio: r.thinness_ratio,
    units: [r.unit_a, r.unit_b]
      .filter((u): u is bigint | number => u !== null)
      .map((u) => Number(u)),
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, unit_a, unit_b, ST_AsGeoJSON(geom) AS _geom
    FROM tc_issues WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      area_m2: number | null;
      max_width_m: number | null;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      _geom: string;
    }>
  ).map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: {
      key: r.key,
      kind: r.kind,
      area_m2: r.area_m2,
      max_width_m: r.max_width_m,
      // BIGINT columns surface as JS `bigint`, which JSON.stringify can't serialize.
      unit_a: r.unit_a === null ? null : Number(r.unit_a),
      unit_b: r.unit_b === null ? null : Number(r.unit_b),
    },
  }));
  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }), failedKinds };
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
