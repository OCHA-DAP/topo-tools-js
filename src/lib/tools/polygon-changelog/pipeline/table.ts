import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { RelClass } from "./classify";

export interface TableRow {
  cluster_id: number;
  relationship_class: RelClass;
  a_fid: number | null;
  a_code: string | null;
  a_name: string | null;
  b_fid: number | null;
  b_code: string | null;
  b_name: string | null;
  coverage_a: number | null;
  coverage_b: number | null;
  iou: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => (v == null ? null : String(v));

// Long-format rows (pairs + singletons) for CrosswalkTable, sorted by
// (cluster_id, a_code, b_code) so the UI's rowspan grouping lines up.

export async function stageTable(conn: AsyncDuckDBConnection): Promise<TableRow[]> {
  // Pairs (matched edges): join codes/names from both keyed tables.
  const pairsRows = (
    await conn.query(`--sql
      SELECT
        p.cluster_id,
        p.relationship_class,
        p.a_fid,
        ak.code AS a_code, ak.name AS a_name,
        p.b_fid,
        bk.code AS b_code, bk.name AS b_name,
        p.coverage_a, p.coverage_b, p.iou
      FROM cw_pairs_classified p
      LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
      LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid
    `)
  ).toArray() as Array<Record<string, unknown>>;

  // Singletons: polygons whose cluster has no member on the other side
  // (symmetric for 'a' and 'b').
  const singletons = (
    await conn.query(`--sql
      WITH cnt AS (
        SELECT cluster_id,
               SUM(CASE WHEN side='a' THEN 1 ELSE 0 END) AS na,
               SUM(CASE WHEN side='b' THEN 1 ELSE 0 END) AS nb
        FROM cw_polygon_class
        GROUP BY cluster_id
      )
      SELECT pc.side, pc.fid, pc.cluster_id, pc.relationship_class,
             ak.code AS a_code, ak.name AS a_name,
             bk.code AS b_code, bk.name AS b_name
      FROM cw_polygon_class pc
      JOIN cnt c ON c.cluster_id = pc.cluster_id
      LEFT JOIN cw_a_keyed ak ON pc.side='a' AND ak.fid = pc.fid
      LEFT JOIN cw_b_keyed bk ON pc.side='b' AND bk.fid = pc.fid
      WHERE (pc.side='a' AND c.nb = 0) OR (pc.side='b' AND c.na = 0)
    `)
  ).toArray() as Array<Record<string, unknown>>;

  const rows: TableRow[] = [];

  for (const r of pairsRows) {
    rows.push({
      cluster_id: num(r.cluster_id) ?? 0,
      relationship_class: r.relationship_class as RelClass,
      a_fid: num(r.a_fid),
      a_code: str(r.a_code),
      a_name: str(r.a_name),
      b_fid: num(r.b_fid),
      b_code: str(r.b_code),
      b_name: str(r.b_name),
      coverage_a: num(r.coverage_a),
      coverage_b: num(r.coverage_b),
      iou: num(r.iou),
    });
  }

  for (const r of singletons) {
    const side = r.side as "a" | "b";
    rows.push({
      cluster_id: num(r.cluster_id) ?? 0,
      relationship_class: r.relationship_class as RelClass,
      a_fid: side === "a" ? num(r.fid) : null,
      a_code: side === "a" ? str(r.a_code) : null,
      a_name: side === "a" ? str(r.a_name) : null,
      b_fid: side === "b" ? num(r.fid) : null,
      b_code: side === "b" ? str(r.b_code) : null,
      b_name: side === "b" ? str(r.b_name) : null,
      coverage_a: null,
      coverage_b: null,
      iou: null,
    });
  }

  rows.sort((x, y) => {
    if (x.cluster_id !== y.cluster_id) return x.cluster_id - y.cluster_id;
    const ax = x.a_code ?? "";
    const ay = y.a_code ?? "";
    if (ax !== ay) return ax.localeCompare(ay);
    const bx = x.b_code ?? "";
    const by = y.b_code ?? "";
    return bx.localeCompare(by);
  });

  return rows;
}
