import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { CrosswalkRow } from "./crosswalk";

// A null/empty target_column drops that source column; geometry lives in
// layer_01 and is never touched here.
export async function renameColumns(conn: AsyncDuckDBConnection, crosswalk: CrosswalkRow[]): Promise<void> {
  const selectCols = crosswalk
    .filter((r) => r.targetColumn)
    .map((r) => `${JSON.stringify(r.sourceColumn)} AS ${JSON.stringify(r.targetColumn)}`);
  const extra = selectCols.length > 0 ? `, ${selectCols.join(", ")}` : "";
  await conn.query(`CREATE OR REPLACE TABLE sr_result_attr AS SELECT fid${extra} FROM layer_attr`);
}
