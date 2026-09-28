import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { AssignmentMethod } from "$lib/db/codeJoin";
import { buildStitchIssues } from "../../stitch/pipeline/issues";

// Combined issues report: dropped input features, leftover stitch gaps, and (when
// a code join was supplied) code-mismatch/code-fallback rows (docs/adr/0045).

export interface MosaicIssueRow {
  key: string;
  kind: "unassigned" | "gap" | "code-mismatch" | "code-fallback";
  areaM2: number | null;
  maxWidthM: number | null;
  thinnessRatio: number | null;
  unitA: number | null;
  overlayFid?: number | null;
  reason?: string | null;
  bbox: [number, number, number, number];
}

export interface MosaicIssuesResult {
  rows: MosaicIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, area_m2, max_width_m}
}

export interface AssignmentOutcomeInfo {
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

export async function buildMosaicIssues(
  conn: AsyncDuckDBConnection,
  assignment: AssignmentOutcomeInfo = {},
): Promise<MosaicIssuesResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_unassigned AS
    SELECT 'unassigned-' || fid AS key, 'unassigned' AS kind,
           NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
           fid AS unit_a, NULL::BIGINT AS overlay_fid, NULL::VARCHAR AS reason,
           geom,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM input_layer_01
    WHERE fid NOT IN (SELECT fid FROM cl_clip)
  `);

  // Every assigned input feature shares the single run-wide assignment_method
  // (assign-one is per-file, not per-input-feature; see docs/adr/0045).
  const codeKind: "code-mismatch" | "code-fallback" | null =
    assignment.assignmentMethod === "code" && assignment.spatialAgrees === false
      ? "code-mismatch"
      : assignment.assignmentMethod === "spatial_fallback"
        ? "code-fallback"
        : null;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_code_issues AS
    SELECT ${codeKind ? `'${codeKind}-' || a.input_fid` : "NULL::VARCHAR"} AS key,
           ${codeKind ? `'${codeKind}'` : "NULL::VARCHAR"} AS kind,
           NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
           a.input_fid AS unit_a, a.overlay_fid AS overlay_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE ${codeKind ? "TRUE" : "FALSE"}
  `);

  const { rows: gapRows } = await buildStitchIssues(conn, "st_clean");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_issues AS
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, overlay_fid, reason,
           geom, xmin, ymin, xmax, ymax
    FROM ms_unassigned
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, overlay_fid, reason,
           geom, xmin, ymin, xmax, ymax
    FROM ms_code_issues
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a,
           NULL::BIGINT AS overlay_fid, NULL::VARCHAR AS reason,
           geom, xmin, ymin, xmax, ymax
    FROM st_issues
  `);
  await conn.query("DROP TABLE IF EXISTS ms_code_issues");

  const meta = (
    await conn.query(`--sql
      SELECT key, kind, unit_a, overlay_fid, xmin, ymin, xmax, ymax
      FROM ms_issues WHERE kind IN ('unassigned', 'code-mismatch', 'code-fallback')
    `)
  ).toArray() as Array<{
    key: string;
    kind: "unassigned" | "code-mismatch" | "code-fallback";
    unit_a: bigint | number;
    overlay_fid: bigint | number | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  }>;

  const rows: MosaicIssueRow[] = [
    ...meta.map((r) => ({
      key: r.key,
      kind: r.kind,
      areaM2: null,
      maxWidthM: null,
      thinnessRatio: null,
      unitA: Number(r.unit_a),
      overlayFid: r.overlay_fid == null ? null : Number(r.overlay_fid),
      reason: null,
      bbox: [r.xmin, r.ymin, r.xmax, r.ymax] as [number, number, number, number],
    })),
    ...gapRows.map((r) => ({
      key: r.key,
      kind: "gap" as const,
      areaM2: r.areaM2,
      maxWidthM: r.maxWidthM,
      thinnessRatio: r.thinnessRatio,
      unitA: null,
      overlayFid: null,
      reason: null,
      bbox: r.bbox,
    })),
  ];

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, unit_a, overlay_fid, ST_AsGeoJSON(geom) AS _geom
    FROM ms_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      area_m2: number | null;
      max_width_m: number | null;
      unit_a: bigint | number | null;
      overlay_fid: bigint | number | null;
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
      unit_a: r.unit_a == null ? null : Number(r.unit_a),
      overlay_fid: r.overlay_fid == null ? null : Number(r.overlay_fid),
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
