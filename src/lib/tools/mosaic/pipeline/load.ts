import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

const OWNED_TABLES = [
  "input_raw_layer",
  "input_layer_01",
  "input_layer_attr",
  "overlay_raw_layer",
  "overlay_layer_01",
  "overlay_layer_attr",
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
  "cl_clip",
  "st_clean",
  "st_gap_regions",
  "st_issues",
  "ms_unassigned",
  "ms_code_issues",
  "ms_issues",
];

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of OWNED_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

// No gatedCoverageClean here: mosaic MUST load both layers raw, same as
// clip (docs/reference/mosaic.md) — the final stitch pass plus its own
// residual-gap issues report are what surface any resulting problems, not
// a pre-check.
export async function loadLayers(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
): Promise<void> {
  await dropPriorRun(conn);
  await loadFile(db, conn, inputFiles, { prefix: "input_" });
  await loadFile(db, conn, overlayFiles, { prefix: "overlay_" });
}
