import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildStitchIssues } from "../../stitch/pipeline/issues";

// Combined issues report: every child that never made it into the final
// stitched output (dropped for not overlapping the winner parent, or for
// clipping to an empty result — both surfaced as one "unassigned" kind,
// matching topo-tools-py's contract: parent id and reason don't apply,
// only the child's own fid does), plus every leftover gap
// buildStitchIssues finds in the stitched result (kind "gap", same shape
// stitch's own issues table uses). Ported from topo-tools-py's mosaic
// _03_outputs issues report.

export interface MosaicIssueRow {
  key: string;
  kind: "unassigned" | "gap";
  areaM2: number | null;
  maxWidthM: number | null;
  thinnessRatio: number | null;
  unitA: number | null;
  bbox: [number, number, number, number];
}

export interface MosaicIssuesResult {
  rows: MosaicIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, area_m2, max_width_m}
}

export async function buildMosaicIssues(conn: AsyncDuckDBConnection): Promise<MosaicIssuesResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_unassigned AS
    SELECT 'unassigned-' || fid AS key, 'unassigned' AS kind,
           NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
           fid AS unit_a,
           geom,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM child_layer_01
    WHERE fid NOT IN (SELECT fid FROM cl_clip)
  `);

  const { rows: gapRows } = await buildStitchIssues(conn, "st_clean");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_issues AS
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, geom, xmin, ymin, xmax, ymax
    FROM ms_unassigned
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, geom, xmin, ymin, xmax, ymax
    FROM st_issues
  `);

  const unassignedMeta = (
    await conn.query(`--sql
      SELECT key, unit_a, xmin, ymin, xmax, ymax FROM ms_unassigned
    `)
  ).toArray() as Array<{
    key: string;
    unit_a: bigint | number;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  }>;

  const rows: MosaicIssueRow[] = [
    ...unassignedMeta.map((r) => ({
      key: r.key,
      kind: "unassigned" as const,
      areaM2: null,
      maxWidthM: null,
      thinnessRatio: null,
      unitA: Number(r.unit_a),
      bbox: [r.xmin, r.ymin, r.xmax, r.ymax] as [number, number, number, number],
    })),
    ...gapRows.map((r) => ({
      key: r.key,
      kind: "gap" as const,
      areaM2: r.areaM2,
      maxWidthM: r.maxWidthM,
      thinnessRatio: r.thinnessRatio,
      unitA: null,
      bbox: r.bbox,
    })),
  ];

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, ST_AsGeoJSON(geom) AS _geom FROM ms_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      area_m2: number | null;
      max_width_m: number | null;
      _geom: string;
    }>
  ).map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: { key: r.key, kind: r.kind, area_m2: r.area_m2, max_width_m: r.max_width_m },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
