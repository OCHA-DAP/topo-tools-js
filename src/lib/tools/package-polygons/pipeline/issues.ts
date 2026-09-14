import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { gapRegionsQuery } from "$lib/db/coverage";
import { degSqToM2, degToM } from "$lib/db/units";

// Gap-only issues report per level table, same shape dissolve's own issues
// table used; a plain GROUP BY dissolve cannot itself produce an overlap.

export interface PolygonIssueRow {
  key: string;
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
): Promise<PolygonIssuesResult> {
  const gapTable = `pp_gap_regions_${level}`;
  const issuesTable = `pp_issues_${level}`;
  await conn.query(gapRegionsQuery(gapTable, sourceTable));

  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT 'gap-' || n AS key, 'gap' AS kind,
           ST_Area(geom) * ${areaFactor} AS area_m2,
           (ST_MaximumInscribedCircle(geom)).radius * 2 * ${widthFactor} AS max_width_m,
           4 * pi() * ST_Area(geom) / POWER(ST_Perimeter(geom), 2) AS thinness_ratio,
           FALSE AS fixed,
           NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b,
           geom,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM ${gapTable}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      AND (ST_MaximumInscribedCircle(geom)).radius * 2 > ${SNAP_TOLERANCE}
  `);

  const meta = await conn.query(`--sql
    SELECT key, area_m2, max_width_m, thinness_ratio, xmin, ymin, xmax, ymax FROM ${issuesTable}
  `);
  const rows: PolygonIssueRow[] = (
    meta.toArray() as Array<{
      key: string;
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
