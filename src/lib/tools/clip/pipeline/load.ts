import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

const OWNED_TABLES = [
  "child_raw_layer",
  "child_layer_01",
  "child_layer_attr",
  "parent_raw_layer",
  "parent_layer_01",
  "parent_layer_attr",
  "cl_child_parts",
  "cl_parent_parts",
  "cl_parent_tiles",
  "cl_heavy_src",
  "cl_heavy_tiles_raw",
  "cl_pairs",
  "cl_assign",
  "cl_parent_one",
  "cl_btile_raw",
  "cl_btile",
  "cl_child_bbox",
  "cl_clip",
];

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of OWNED_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

// No gatedCoverageClean here: clip MUST load both layers raw, neither
// coverage-checked nor -cleaned (docs/reference/clip.md) — whatever seams
// exist between clipped pieces are stitch's job downstream, not clip's.
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
