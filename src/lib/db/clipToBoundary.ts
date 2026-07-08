import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { withNodingRetry } from "./precisionRetry";

// Clips `sourceTable` (fid, geom) against a single, already-known boundary
// polygon, writing (fid, geom) to `targetTable`. Used by Edge Matcher's
// per-group parent clip (match/pipeline/groups.ts, which already knows the
// exact parent fid to clip against). Kept as a standalone module rather than
// inlined because it encodes a hard-won fix (see below) that's easy to get
// wrong if re-derived — Edge Extender's own former clip-to-boundary feature
// (removed) used this same helper before it was dropped, so a future
// "clip a derived layer to one known boundary" need elsewhere isn't
// hypothetical, it's already happened once. `boundarySql` must select
// exactly one row with a `geom` column, e.g.
// `SELECT geom FROM parent_layer_01 WHERE fid = 5`.
//
// Retries at decreasing precision applied only to `sourceTable`'s geometry
// (the derived side) — the same WASM-only GEOS noding bug documented in
// docs/wasm-geos-noding-investigation.md can hit this ST_Intersection.
// `boundarySql`'s geometry (real input) is never precision-reduced.
export async function clipToBoundary(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  boundarySql: string,
  targetTable: string,
): Promise<void> {
  await withNodingRetry(async (precision) => {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT fid, geom FROM (
        SELECT a.fid, ST_Intersection(ST_ReducePrecision(a.geom, ${precision}), c.geom) AS geom
        FROM ${sourceTable} a CROSS JOIN (${boundarySql}) c
        WHERE ST_Intersects(a.geom, c.geom)
      ) WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  });
}
