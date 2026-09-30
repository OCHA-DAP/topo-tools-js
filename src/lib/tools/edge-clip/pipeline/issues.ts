import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOneDropIssuesSql } from "$lib/db/assignOne";
import {
  CODE_FALLBACK_REASON,
  CODE_MISMATCH_REASON,
  type AssignmentMethod,
} from "$lib/db/codeJoin";

// Clip's issues report: dropped input features, merged or dropped
// micro-polygons, and code-join rows when one was supplied (docs/adr/0045).

type ClipIssueKind =
  "unassigned" | "clip-empty" | "micro-polygon" | "code-mismatch" | "code-fallback";

export interface ClipIssueRow {
  key: string;
  kind: ClipIssueKind;
  unitA: number;
  unitB: number | null; // micro-polygon rows: the receiving fid, null when dropped
  overlayFid: number | null;
  reason: string | null;
  bbox: [number, number, number, number];
}

export interface ClipIssuesResult {
  rows: ClipIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, unit_a, unit_b, overlay_fid, reason}
}

export interface AssignmentOutcomeInfo {
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

export async function buildClipIssues(
  conn: AsyncDuckDBConnection,
  assignment: AssignmentOutcomeInfo = {},
): Promise<ClipIssuesResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_unassigned_issues AS
    ${assignOneDropIssuesSql("cl_clip", "cl_micro")}
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
    SELECT key, kind, unit_a, NULL::BIGINT AS unit_b, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_unassigned_issues
    UNION ALL
    SELECT key, kind, unit_a, unit_b, NULL::BIGINT, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_micro
    UNION ALL
    SELECT key, kind, unit_a, NULL::BIGINT, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_code_issues
  `);
  await conn.query("DROP TABLE IF EXISTS cl_unassigned_issues");
  await conn.query("DROP TABLE IF EXISTS cl_code_issues");
  await conn.query("DROP TABLE IF EXISTS cl_micro");

  const meta = (
    await conn.query(`--sql
      SELECT key, kind, unit_a, unit_b, overlay_fid, reason, xmin, ymin, xmax, ymax FROM cl_issues
    `)
  ).toArray() as Array<{
    key: string;
    kind: ClipIssueKind;
    unit_a: bigint | number;
    unit_b: bigint | number | null;
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
    unitB: r.unit_b == null ? null : Number(r.unit_b),
    overlayFid: r.overlay_fid == null ? null : Number(r.overlay_fid),
    reason: r.reason,
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, unit_a, unit_b, overlay_fid, reason, ST_AsGeoJSON(geom) AS _geom FROM cl_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      unit_a: bigint | number;
      unit_b: bigint | number | null;
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
      unit_b: r.unit_b == null ? null : Number(r.unit_b),
      overlay_fid: r.overlay_fid == null ? null : Number(r.overlay_fid),
      reason: r.reason,
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
