import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { AssignmentMethod } from "$lib/db/codeJoin";

// Clip's first issues report: dropped children plus code-mismatch/
// code-fallback rows when a code join was supplied (docs/adr/0045).

export interface ClipIssueRow {
  key: string;
  kind: "unassigned" | "clip-empty" | "code-mismatch" | "code-fallback";
  unitA: number;
  parentFid: number | null;
  reason: string | null;
  bbox: [number, number, number, number];
}

export interface ClipIssuesResult {
  rows: ClipIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, unit_a, parent_fid}
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
           c.fid AS unit_a, NULL::BIGINT AS parent_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM child_layer_01 c
    WHERE c.fid NOT IN (SELECT fid FROM cl_clip)
      AND c.fid NOT IN (SELECT child_fid FROM cl_assign)
    UNION ALL
    SELECT 'clip-empty-' || a.child_fid AS key, 'clip-empty' AS kind,
           a.child_fid AS unit_a, a.parent_fid AS parent_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN child_layer_01 c ON c.fid = a.child_fid
    WHERE a.child_fid NOT IN (SELECT fid FROM cl_clip)
  `);

  // Every assigned child shares the single run-wide assignment_method
  // (assign-one is per-file, not per-child; see docs/adr/0045).
  const codeKind: "code-mismatch" | "code-fallback" | null =
    assignment.assignmentMethod === "code" && assignment.spatialAgrees === false
      ? "code-mismatch"
      : assignment.assignmentMethod === "spatial_fallback"
        ? "code-fallback"
        : null;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_code_issues AS
    SELECT ${codeKind ? `'${codeKind}-' || a.child_fid` : "NULL::VARCHAR"} AS key,
           ${codeKind ? `'${codeKind}'` : "NULL::VARCHAR"} AS kind,
           a.child_fid AS unit_a, a.parent_fid AS parent_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN child_layer_01 c ON c.fid = a.child_fid
    WHERE ${codeKind ? "TRUE" : "FALSE"}
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_issues AS
    SELECT key, kind, unit_a, parent_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_unassigned_issues
    UNION ALL
    SELECT key, kind, unit_a, parent_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_code_issues
  `);
  await conn.query("DROP TABLE IF EXISTS cl_unassigned_issues");
  await conn.query("DROP TABLE IF EXISTS cl_code_issues");

  const meta = (
    await conn.query(`--sql
      SELECT key, kind, unit_a, parent_fid, xmin, ymin, xmax, ymax FROM cl_issues
    `)
  ).toArray() as Array<{
    key: string;
    kind: "unassigned" | "clip-empty" | "code-mismatch" | "code-fallback";
    unit_a: bigint | number;
    parent_fid: bigint | number | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  }>;

  const rows: ClipIssueRow[] = meta.map((r) => ({
    key: r.key,
    kind: r.kind,
    unitA: Number(r.unit_a),
    parentFid: r.parent_fid == null ? null : Number(r.parent_fid),
    reason: null,
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, unit_a, parent_fid, ST_AsGeoJSON(geom) AS _geom FROM cl_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      unit_a: bigint | number;
      parent_fid: bigint | number | null;
      _geom: string;
    }>
  ).map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: {
      key: r.key,
      kind: r.kind,
      unit_a: Number(r.unit_a),
      parent_fid: r.parent_fid == null ? null : Number(r.parent_fid),
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
