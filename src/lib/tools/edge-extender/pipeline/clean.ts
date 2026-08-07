import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean } from "$lib/db/coverageClean";

// Only cleans layer_01 when ST_CoverageInvalidEdges_Agg actually flags a
// defect — an unconditional clean was tried and made WASM failure rates
// worse, not better. Lives here rather than in the shared loader because
// Topology Cleaner reuses that same loader and needs the raw, un-cleaned
// input to detect and report violations itself.
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
