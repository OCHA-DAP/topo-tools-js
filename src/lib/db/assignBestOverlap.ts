import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { computeOverlapPairs } from "./overlap";

// Per-input-feature plurality pick: largest shared_area wins, b_fid breaks a tie.
// Shared by `match`, `code-update` (reparent), and `schema-join`.
export async function assignBestOverlap(
  conn: AsyncDuckDBConnection,
  inputTable: string,
  overlayTable: string,
  pairsTable: string,
  outputTable: string,
): Promise<void> {
  await computeOverlapPairs(conn, inputTable, overlayTable, pairsTable);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${outputTable} AS
    SELECT a_fid AS input_fid, b_fid AS overlay_fid
    FROM (
      SELECT a_fid, b_fid,
             ROW_NUMBER() OVER (PARTITION BY a_fid ORDER BY shared_area DESC, b_fid ASC) AS rn
      FROM ${pairsTable}
    )
    WHERE rn = 1
  `);
}
