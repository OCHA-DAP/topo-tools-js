import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Floor for boundaries with no finer natural resolution — the fallback for
// files with no real segments to measure.
export const DEFAULT_DISTANCE = 0.0002;

// Assumes buildSegments (points.ts) has already created layer_03_tmp1.
//
// effective_distance = MIN(DEFAULT_DISTANCE, naturalRes). naturalRes (median
// real segment length) lets files with genuinely finer source detail than
// DEFAULT_DISTANCE start there instead of losing that detail to a coarser
// default.
export async function computeEffectiveDistance(conn: AsyncDuckDBConnection): Promise<number> {
  const statsResult = await conn.query(`--sql
    SELECT median(seg_len) AS natural_res FROM layer_03_tmp1
  `);
  const naturalRes = (statsResult.toArray()[0] as { natural_res: number | null }).natural_res;
  if (naturalRes === null) {
    console.info("distance-calc: no real segments, using default");
    return DEFAULT_DISTANCE;
  }
  return Math.min(DEFAULT_DISTANCE, naturalRes);
}
