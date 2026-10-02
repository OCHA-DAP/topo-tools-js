import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

const OWNED_TABLES = [
  "input_raw_layer",
  "input_layer_01",
  "input_layer_attr",
  "overlay_raw_layer",
  "overlay_layer_01",
  "overlay_layer_attr",
  "original_raw_layer",
  "original_layer_01",
  "original_layer_attr",
  "cl_input_parts",
  "cl_overlay_parts",
  "cl_overlay_pieces",
  "cl_heavy_src",
  "cl_heavy_tiles_raw",
  "cl_pairs_geom",
  "cl_pairs_raw",
  "cl_pairs",
  "cl_assign",
  "cl_overlay_one",
  "cl_btile_raw",
  "cl_btile",
  "cl_input_bbox",
  "cl_clip_pieces",
  "cl_clip",
  "cl_detached",
  "cl_unassigned_issues",
  "cl_code_issues",
  "cl_issues",
];

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of OWNED_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

// No gatedCoverageClean here: clip MUST load both layers raw, neither
// coverage-checked nor -cleaned (docs/reference/edge-clip.md) — whatever seams
// exist between clipped pieces are stitch's job downstream, not clip's.
export async function loadLayers(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  originalFiles: File[] = [],
): Promise<void> {
  await dropPriorRun(conn);
  await loadFile(db, conn, inputFiles, { prefix: "input_" });
  await loadFile(db, conn, overlayFiles, { prefix: "overlay_" });
  if (originalFiles.length > 0) await loadFile(db, conn, originalFiles, { prefix: "original_" });
}
