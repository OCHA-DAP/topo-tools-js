import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

// Tables this tool owns, dropped defensively before every run so re-running
// with different inputs in the same session starts clean. child_*/parent_*
// are also dropped internally by loadFile itself, but listed here too for a
// complete, self-documenting sweep.
const OWNED_TABLES = [
  "child_raw_layer",
  "child_layer_01",
  "child_layer_attr",
  "parent_raw_layer",
  "parent_layer_01",
  "parent_layer_attr",
  "ge_pairs",
  "ge_assignment",
  "ge_unassigned",
  "ge_groups",
  "ge_group_clip",
  "ge_results",
  "ge_results_attr",
];

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of OWNED_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

export async function loadLayers(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  childFiles: File[],
  parentFiles: File[],
): Promise<void> {
  await dropPriorRun(conn);
  await loadFile(db, conn, childFiles, { prefix: "child_" });
  await loadFile(db, conn, parentFiles, { prefix: "parent_" });
}
