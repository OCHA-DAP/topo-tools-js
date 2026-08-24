import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { CrosswalkRow } from "./inference";

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const sqlStrOrNull = (s: string | null): string => (s === null ? "NULL" : sqlStr(s));

// `column_order` plus an explicit ORDER BY at CSV-export time keeps row
// order deterministic under this app's `preserve_insertion_order = false`.
export async function writeCrosswalkTable(
  conn: AsyncDuckDBConnection,
  rows: CrosswalkRow[],
): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS sm_crosswalk");
  await conn.query(`
    CREATE TABLE sm_crosswalk (
      column_order INTEGER, source_column VARCHAR, target_column VARCHAR,
      unique_count INTEGER, note VARCHAR
    )
  `);
  if (rows.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = slice
      .map(
        (r, j) =>
          `(${i + j}, ${sqlStr(r.sourceColumn)}, ${sqlStrOrNull(r.targetColumn)}, ${r.uniqueCount}, ${sqlStr(r.note)})`,
      )
      .join(", ");
    await conn.query(`INSERT INTO sm_crosswalk VALUES ${values}`);
  }
}
