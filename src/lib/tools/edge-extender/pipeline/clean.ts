import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean } from "$lib/db/coverageClean";

// Mirrors Python's app/_01_inputs.py: after the loader normalizes layer_01,
// check whether the input coverage already has overlap/gap topology defects
// (ST_CoverageInvalidEdges_Agg) and if so, rewrite layer_01 in place via
// ST_CoverageClean before the extension algorithm runs downstream — Voronoi
// generation assumes a clean starting coverage.
//
// Tried making this unconditional (always clean, not just when the gate
// fires) to also catch polygons whose shared border is geometrically
// coincident but built from different vertex sets — a case the gap/overlap
// check misses, and one that can trip GEOS's noding step downstream in
// stageLines with "found non-noded intersection". In practice, forcing
// ST_CoverageClean onto every group (not just ones that actually needed it)
// made things worse, not better — real-world testing went from 2 failing
// groups out of ~75 to 15, almost certainly because CoverageClean's own
// WASM-GEOS implementation has its own robustness edge cases and running it
// on inputs that didn't need touching introduced new failures more often
// than it fixed the target one. Reverted — see reference-wasm-overlayng-fp-
// divergence for the broader GEOS-on-WASM robustness pattern this fits.
//
// This lives here, not in the shared loader, because Topology Cleaner reuses
// the same loader for its own layer_01 and needs the RAW, un-cleaned input to
// detect and report violations itself; silently pre-cleaning at load time
// would defeat that tool's purpose.
export async function stageCleanInput(conn: AsyncDuckDBConnection): Promise<void> {
  console.log("[EE-DEBUG] clean:1 invalid-edges-check");
  const r = await conn.query(`--sql
    SELECT ST_CoverageInvalidEdges_Agg(geom) IS NOT NULL AS bad
    FROM (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM layer_01)
  `);
  if (!r.toArray()[0].bad) return;

  console.log("[EE-DEBUG] clean:2 buildCoverageClean");
  await buildCoverageClean(conn, "layer_01", "layer_01_tmp_clean", { preserveOriginal: true });
  console.log("[EE-DEBUG] clean:3 replace layer_01");
  await conn.query("CREATE OR REPLACE TABLE layer_01 AS SELECT * FROM layer_01_tmp_clean");
  console.log("[EE-DEBUG] clean:4 drop tmp_clean");
  await conn.query("DROP TABLE layer_01_tmp_clean");
}
