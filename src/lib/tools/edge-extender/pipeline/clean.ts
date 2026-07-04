import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean } from "$lib/db/coverageClean";

// Mirrors Python's app/_01_inputs.py: after the loader normalizes layer_01,
// check whether the input coverage already has overlap/gap topology defects
// (ST_CoverageInvalidEdges_Agg) and if so, rewrite layer_01 in place via
// ST_CoverageClean before the extension algorithm runs downstream — Voronoi
// generation assumes a clean starting coverage.
//
// This lives here, not in the shared loader, because Topology Cleaner reuses
// the same loader for its own layer_01 and needs the RAW, un-cleaned input to
// detect and report violations itself; silently pre-cleaning at load time
// would defeat that tool's purpose.
export async function stageCleanInput(conn: AsyncDuckDBConnection): Promise<void> {
  const r = await conn.query(`--sql
    SELECT ST_CoverageInvalidEdges_Agg(geom) IS NOT NULL AS bad
    FROM (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM layer_01)
  `);
  if (!r.toArray()[0].bad) return;

  await buildCoverageClean(conn, "layer_01", "layer_01_tmp_clean", { preserveOriginal: true });
  await conn.query("CREATE OR REPLACE TABLE layer_01 AS SELECT * FROM layer_01_tmp_clean");
  await conn.query("DROP TABLE layer_01_tmp_clean");
}
