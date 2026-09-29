import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildGapTable } from "$lib/db/coverage";
import { gapIssuesSql } from "$lib/db/issues";

// Gap issues report per level table (a plain GROUP BY dissolve cannot itself
// produce an overlap), plus the input's micro-polygon rows at the finest level.

export interface PolygonIssueRow {
  key: string;
  kind: "gap" | "micro-polygon";
  areaM2: number;
  maxWidthM: number;
  thinnessRatio: number;
  bbox: [number, number, number, number];
}

export interface PolygonIssuesResult {
  rows: PolygonIssueRow[];
  geojson: string;
}

export async function buildPolygonIssues(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  level: number,
  microTable: string | null = null,
): Promise<PolygonIssuesResult> {
  const gapTable = `pp_gap_regions_${level}`;
  const issuesTable = `pp_issues_${level}`;
  await buildGapTable(conn, gapTable, sourceTable);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, fixed, unit_a, unit_b,
           geom, xmin, ymin, xmax, ymax
    FROM (${gapIssuesSql(gapTable)})
    ${
      microTable
        ? `UNION ALL
    SELECT key, kind, area_m2, max_width_m, NULL::DOUBLE, fixed, unit_a, unit_b,
           geom, xmin, ymin, xmax, ymax
    FROM ${microTable}`
        : ""
    }
  `);

  const meta = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, xmin, ymin, xmax, ymax
    FROM ${issuesTable}
  `);
  const rows: PolygonIssueRow[] = (
    meta.toArray() as Array<{
      key: string;
      kind: "gap" | "micro-polygon";
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
    areaM2: r.area_m2 ?? NaN,
    maxWidthM: r.max_width_m ?? NaN,
    thinnessRatio: r.thinness_ratio ?? NaN,
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, ST_AsGeoJSON(geom) AS _geom FROM ${issuesTable}
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
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
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
