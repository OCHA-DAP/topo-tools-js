import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  CODE_FALLBACK_REASON,
  CODE_MISMATCH_REASON,
  type AssignmentMethod,
} from "$lib/db/codeJoin";

// Clip's first issues report: dropped input features plus code-mismatch/
// code-fallback rows when a code join was supplied (docs/adr/0045).

export interface ClipIssueRow {
  key: string;
  kind: "unassigned" | "clip-empty" | "code-mismatch" | "code-fallback";
  unitA: number;
  overlayFid: number | null;
  reason: string | null;
  bbox: [number, number, number, number];
}

export interface ClipIssuesResult {
  rows: ClipIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, unit_a, overlay_fid, reason}
}

export interface AssignmentOutcomeInfo {
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

export async function buildClipIssues(
  conn: AsyncDuckDBConnection,
  assignment: AssignmentOutcomeInfo = {},
): Promise<ClipIssuesResult> {
  // A fid missing from cl_assign was never spatially/code-matched; a fid in
  // cl_assign but not cl_clip was assigned but its clip intersection was empty.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_unassigned_issues AS
    SELECT 'unassigned-' || c.fid AS key, 'unassigned' AS kind,
           c.fid AS unit_a, NULL::BIGINT AS overlay_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM input_layer_01 c
    WHERE c.fid NOT IN (SELECT fid FROM cl_clip)
      AND c.fid NOT IN (SELECT input_fid FROM cl_assign)
    UNION ALL
    SELECT 'clip-empty-' || a.input_fid AS key, 'clip-empty' AS kind,
           a.input_fid AS unit_a, a.overlay_fid AS overlay_fid,
           'clip intersection with its overlay feature was empty' AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.input_fid NOT IN (SELECT fid FROM cl_clip)
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
    CREATE OR REPLACE TABLE cl_code_issues AS
    SELECT ${codeKind ? `'${codeKind}-' || a.input_fid` : "NULL::VARCHAR"} AS key,
           ${codeKind ? `'${codeKind}'` : "NULL::VARCHAR"} AS kind,
           a.input_fid AS unit_a, a.overlay_fid AS overlay_fid,
           ${codeKind === "code-mismatch" ? `'${CODE_MISMATCH_REASON}'` : codeKind === "code-fallback" ? `'${CODE_FALLBACK_REASON}'` : "NULL::VARCHAR"} AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE ${codeKind ? "TRUE" : "FALSE"}
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_issues AS
    SELECT key, kind, unit_a, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_unassigned_issues
    UNION ALL
    SELECT key, kind, unit_a, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_code_issues
  `);
  await conn.query("DROP TABLE IF EXISTS cl_unassigned_issues");
  await conn.query("DROP TABLE IF EXISTS cl_code_issues");

  const meta = (
    await conn.query(`--sql
      SELECT key, kind, unit_a, overlay_fid, reason, xmin, ymin, xmax, ymax FROM cl_issues
    `)
  ).toArray() as Array<{
    key: string;
    kind: "unassigned" | "clip-empty" | "code-mismatch" | "code-fallback";
    unit_a: bigint | number;
    overlay_fid: bigint | number | null;
    reason: string | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  }>;

  const rows: ClipIssueRow[] = meta.map((r) => ({
    key: r.key,
    kind: r.kind,
    unitA: Number(r.unit_a),
    overlayFid: r.overlay_fid == null ? null : Number(r.overlay_fid),
    reason: r.reason,
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, unit_a, overlay_fid, reason, ST_AsGeoJSON(geom) AS _geom FROM cl_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      unit_a: bigint | number;
      overlay_fid: bigint | number | null;
      reason: string | null;
      _geom: string;
    }>
  ).map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: {
      key: r.key,
      kind: r.kind,
      unit_a: Number(r.unit_a),
      overlay_fid: r.overlay_fid == null ? null : Number(r.overlay_fid),
      reason: r.reason,
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
