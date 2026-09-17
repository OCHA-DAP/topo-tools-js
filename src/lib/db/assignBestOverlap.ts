import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { computeOverlapPairs } from "./overlap";

// Per-child plurality pick: largest shared_area wins, b_fid breaks a tie.
// Shared by `match` (parent/child assignment) and `code-update` (reparent).
export async function assignBestOverlap(
  conn: AsyncDuckDBConnection,
  childTable: string,
  parentTable: string,
  pairsTable: string,
  outputTable: string,
): Promise<void> {
  await computeOverlapPairs(conn, childTable, parentTable, pairsTable);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${outputTable} AS
    SELECT a_fid AS child_fid, b_fid AS parent_fid
    FROM (
      SELECT a_fid, b_fid,
             ROW_NUMBER() OVER (PARTITION BY a_fid ORDER BY shared_area DESC, b_fid ASC) AS rn
      FROM ${pairsTable}
    )
    WHERE rn = 1
  `);
}
