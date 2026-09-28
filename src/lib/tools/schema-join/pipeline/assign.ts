import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignBestOverlap } from "$lib/db/assignBestOverlap";

// Pairs each input feature with its plurality-overlap join feature (sj_assign) and that
// join feature's share of the input feature's area (sj_share).
export async function assignJoinFeatures(conn: AsyncDuckDBConnection): Promise<void> {
  await assignBestOverlap(conn, "input_layer_01", "join_layer_01", "sj_pairs", "sj_best");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE sj_assign AS
    SELECT child_fid AS input_fid, parent_fid AS join_fid FROM sj_best
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE sj_share AS
    SELECT a.input_fid, a.join_fid, p.shared_area,
           p.shared_area / NULLIF(p.coverage_a, 0) AS input_area,
           p.coverage_a AS overlap_share
    FROM sj_assign a
    JOIN sj_pairs p ON p.a_fid = a.input_fid AND p.b_fid = a.join_fid
  `);
  await conn.query("DROP TABLE IF EXISTS sj_pairs");
  await conn.query("DROP TABLE IF EXISTS sj_best");
}
