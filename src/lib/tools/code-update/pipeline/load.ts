import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";
import { gatedCoverageClean } from "$lib/db/coverageClean";

// cu_a_/cu_b_ prefix = OLD (already coded) / NEW (uncoded candidate).
export async function loadSide(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  files: File[],
): Promise<void> {
  const prefix = `cu_${side}_`;
  await loadFile(db, conn, files, { prefix });
  await gatedCoverageClean(conn, `${prefix}layer_01`);
}

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  const r = await conn.query(`--sql
    SELECT table_name FROM information_schema.tables
    WHERE table_name LIKE 'cu_%' OR table_name LIKE 'cw_%'
  `);
  const tables = (r.toArray() as Array<{ table_name: string }>).map((row) => row.table_name);
  for (const t of tables) await conn.query(`DROP TABLE IF EXISTS "${t}"`);
}
