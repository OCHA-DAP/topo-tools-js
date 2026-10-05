import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { ROW_ORDER_COLUMN } from "$lib/db/export";
import type { Bounds } from "$lib/db/layerView";

export type JoinIssueKind = "no-overlap" | "low-overlap" | "value-mismatch";

export interface JoinIssueRow {
  key: string;
  kind: JoinIssueKind;
  unitA: number;
  joinFid: number | null;
  reason: string;
  bbox: Bounds;
}

// Builds sj_issues: no-overlap, low-overlap, and value-mismatch rows, keyed by output row.
export async function buildJoinIssues(
  conn: AsyncDuckDBConnection,
  minOverlap: number,
): Promise<JoinIssueRow[]> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE sj_issues AS
    WITH out_rows AS (SELECT fid, ${ROW_ORDER_COLUMN} AS out_fid FROM sj_result_attr),
    issue_rows AS (
      SELECT 'no-overlap-' || o.out_fid AS key, 'no-overlap' AS kind,
             o.out_fid AS unit_a, NULL::BIGINT AS join_fid,
             'input polygon overlaps no join polygon; join columns left NULL' AS reason,
             NULL::DOUBLE AS area_m2, c.geom
      FROM input_layer_01 c JOIN out_rows o ON o.fid = c.fid
      WHERE c.fid NOT IN (SELECT input_fid FROM sj_assign)
      UNION ALL BY NAME
      SELECT 'low-overlap-' || o.out_fid AS key, 'low-overlap' AS kind,
             o.out_fid AS unit_a, s.join_fid,
             printf('best join polygon covers %.2f of input polygon', s.overlap_share) AS reason,
             s.input_area - s.shared_area AS area_m2, c.geom
      FROM sj_share s
      JOIN input_layer_01 c ON c.fid = s.input_fid
      JOIN out_rows o ON o.fid = c.fid
      WHERE s.overlap_share < ${minOverlap}
      UNION ALL BY NAME
      SELECT 'value-mismatch-' || o.out_fid || '-' || m.column_name AS key,
             'value-mismatch' AS kind, o.out_fid AS unit_a, m.join_fid,
             printf('%s: input ''%s'' vs join ''%s''',
                    m.column_name, m.input_value, m.join_value) AS reason,
             NULL::DOUBLE AS area_m2, c.geom
      FROM sj_mismatch m
      JOIN input_layer_01 c ON c.fid = m.input_fid
      JOIN out_rows o ON o.fid = c.fid
    )
    SELECT *, ROW_NUMBER() OVER (ORDER BY unit_a, kind, key) AS ${ROW_ORDER_COLUMN} FROM issue_rows
  `);
  const r = await conn.query(`--sql
    SELECT key, kind, unit_a, join_fid, reason,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM sj_issues ORDER BY ${ROW_ORDER_COLUMN}
  `);
  return (r.toArray() as Array<Record<string, unknown>>).map((row) => ({
    key: String(row.key),
    kind: row.kind as JoinIssueKind,
    unitA: Number(row.unit_a),
    joinFid: row.join_fid == null ? null : Number(row.join_fid),
    reason: String(row.reason),
    bbox: [row.xmin, row.ymin, row.xmax, row.ymax].map(Number) as Bounds,
  }));
}
