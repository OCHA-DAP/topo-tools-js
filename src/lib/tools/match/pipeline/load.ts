import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";
import { gatedCoverageClean } from "$lib/db/coverageClean";

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

  // Clean both input layers up front, at default (auto snap, no gap-fill)
  // settings, gated so untouched inputs pay only the cheap invalid-edges
  // check. The parent layer is never cleaned anywhere else in this pipeline
  // — real source data commonly carries pre-existing seam imprecision (e.g.
  // ~80m of it across 43 real-world commune polygons, see
  // docs/wasm-geos-noding-investigation.md), and that imprecision is exactly
  // what the per-group clip step (clipToBoundary.ts) has no way to fix
  // later. The child layer already gets a gated clean per-group inside each
  // group's own runPipeline (edge-extender/pipeline/clean.ts), but only
  // within that group's subset — a defect between two child units assigned
  // to different groups is invisible to that gate, so it needs its own
  // whole-layer pass here too.
  await gatedCoverageClean(conn, "parent_layer_01");
  await gatedCoverageClean(conn, "child_layer_01");
}
