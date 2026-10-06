import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean, needsCoverageClean } from "$lib/db/coverageClean";
import { tryCloseNotches } from "$lib/db/notches";

// Only cleans layer_01 when needsCoverageClean flags a defect: an
// unconditional clean was tried and made WASM failure rates worse, not
// better. Lives here rather than in the shared loader because Topology
// Cleaner reuses that same loader and needs the raw, un-cleaned input to
// detect and report violations itself.
export async function stageCleanInput(
  conn: AsyncDuckDBConnection,
  anyHole: boolean,
  fixNotches: boolean,
): Promise<void> {
  if (fixNotches) await tryCloseNotches(conn, "layer_01");
  console.log("[EE-DEBUG] clean:1 needs-clean-check");
  if (!(await needsCoverageClean(conn, "layer_01", anyHole))) return;

  console.log("[EE-DEBUG] clean:2 buildCoverageClean");
  await buildCoverageClean(conn, "layer_01", "layer_01_tmp_clean", { preserveOriginal: true });
  console.log("[EE-DEBUG] clean:3 replace layer_01");
  await conn.query("CREATE OR REPLACE TABLE layer_01 AS SELECT * FROM layer_01_tmp_clean");
  console.log("[EE-DEBUG] clean:4 drop tmp_clean");
  await conn.query("DROP TABLE layer_01_tmp_clean");
}
