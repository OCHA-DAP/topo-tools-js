import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignBestOverlap } from "$lib/db/assignBestOverlap";

// Writes cu_reparent_{n}_assign: each NEW fid's true parent fid, re-derived
// spatially against the previous level's NEW dissolve (not a stale column).
export async function reparentLevel(conn: AsyncDuckDBConnection, n: number, prevLevel: number): Promise<void> {
  await assignBestOverlap(
    conn,
    `cu_dsl_${n}_b`,
    `cu_dsl_${prevLevel}_b`,
    `cu_reparent_${n}_pairs`,
    `cu_reparent_${n}_assign`,
  );
}
