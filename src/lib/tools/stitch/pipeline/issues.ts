import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildGapTable } from "$lib/db/coverage";
import { gapIssuesSql } from "$lib/db/issues";

// Issues report: any interior hole left in sourceTable wider than
// SNAP_TOLERANCE after the whole-table coverage-clean pass, plus the clean's
// merged or dropped micro-polygons (st_micro). Unlike
// topology-cleaner's issues table, stitch has no "fixed" concept (there's
// only ever one clean pass, not a reclean loop) and no overlap rows
// (ST_CoverageClean removes those by construction) — matches
// topo-tools-py's gap_issues_sql(). Column shape matches topology-cleaner's
// tc_issues for schema consistency, though unit_a/unit_b/fixed etc. are
// always null/false here.

export interface StitchIssueRow {
  key: string;
  kind: "gap" | "micro-polygon";
  unitA: number | null;
  unitB: number | null;
  reason: string | null;
  areaM2: number;
  maxWidthM: number;
  thinnessRatio: number;
  bbox: [number, number, number, number];
}

export interface StitchIssuesResult {
  rows: StitchIssueRow[];
  geojson: string; // FeatureCollection of gap polygons, props {key, area_m2, max_width_m}
}

export async function buildStitchIssues(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
): Promise<StitchIssuesResult> {
  await buildGapTable(conn, "st_gap_regions", sourceTable);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE st_issues AS
    ${gapIssuesSql("st_gap_regions")}
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, NULL::DOUBLE, fixed, unit_a, unit_b, reason,
           geom, xmin, ymin, xmax, ymax
    FROM st_micro
  `);

  const meta = await conn.query(`--sql
    SELECT key, kind, unit_a, unit_b, reason, area_m2, max_width_m, thinness_ratio,
           xmin, ymin, xmax, ymax
    FROM st_issues
  `);
  const rows: StitchIssueRow[] = (
    meta.toArray() as Array<{
      key: string;
      kind: "gap" | "micro-polygon";
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      reason: string | null;
      area_m2: number | null;
      max_width_m: number | null;
      thinness_ratio: number | null;
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
    }>
  ).map((r) => ({
    key: r.key,
    kind: r.kind,
    unitA: r.unit_a == null ? null : Number(r.unit_a),
    unitB: r.unit_b == null ? null : Number(r.unit_b),
    reason: r.reason,
    areaM2: r.area_m2 ?? NaN,
    maxWidthM: r.max_width_m ?? NaN,
    thinnessRatio: r.thinness_ratio ?? NaN,
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, unit_b, reason,
           ST_AsGeoJSON(geom) AS _geom
    FROM st_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      reason: string | null;
      area_m2: number | null;
      max_width_m: number | null;
      thinness_ratio: number | null;
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
      thinness_ratio: r.thinness_ratio,
      unit_a: r.unit_a == null ? null : Number(r.unit_a),
      unit_b: r.unit_b == null ? null : Number(r.unit_b),
      reason: r.reason,
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
