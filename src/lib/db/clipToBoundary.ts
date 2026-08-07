import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { withNodingRetry } from "./precisionRetry";

// Clips `sourceTable` (fid, geom) against a single, already-known boundary
// polygon, writing (fid, geom) to `targetTable`. `boundarySql` must select
// exactly one row with a `geom` column, e.g.
// `SELECT geom FROM parent_layer_01 WHERE fid = 5`. Precision retry applies
// only to `sourceTable` (the derived side); `boundarySql`'s real input
// geometry is never reduced.
export async function clipToBoundary(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  boundarySql: string,
  targetTable: string,
): Promise<void> {
  await withNodingRetry(async (precision) => {
    // ST_Intersection against a boundary meant to touch exactly can return a
    // GeometryCollection (real polygon plus stray point/line noise);
    // ST_CollectionExtract keeps only the polygonal parts.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT fid, geom FROM (
        SELECT a.fid,
               ST_CollectionExtract(
                 ST_Intersection(ST_ReducePrecision(a.geom, ${precision}), c.geom), 3
               ) AS geom
        FROM ${sourceTable} a CROSS JOIN (${boundarySql}) c
        WHERE ST_Intersects(a.geom, c.geom)
      ) WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  });
}
