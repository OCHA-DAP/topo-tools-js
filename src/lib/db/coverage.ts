import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";

export async function emptyRegions(
  conn: AsyncDuckDBConnection,
  table: string,
  extra = "",
): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TABLE ${table} AS SELECT NULL::BIGINT AS n${extra}, NULL::GEOMETRY AS geom WHERE FALSE`,
  );
}

// Gap regions = enclosed areas not covered by any polygon in the source table.
// Computed directly: union all polygons → interior rings of the union ARE the
// gaps → convert each ring back to a polygon via difference against the filled
// exterior. Independent of ST_CoverageClean, so works even when the coverage
// has overlaps or degenerate edges that would trip the cleaner.
export function gapRegionsQuery(targetTable: string, sourceTable: string): string {
  return `--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH
    union_cte AS (
      SELECT ST_Union_Agg(geom) AS u
      FROM ${sourceTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    ),
    parts AS (
      SELECT (UNNEST(ST_Dump(u))).geom AS poly
      FROM union_cte WHERE u IS NOT NULL
    ),
    holes AS (
      SELECT UNNEST(ST_Dump(
        ST_Difference(ST_MakePolygon(ST_ExteriorRing(poly)), poly)
      )).geom AS geom
      FROM parts WHERE ST_NumInteriorRings(poly) > 0
    )
    SELECT row_number() OVER () AS n, geom
    FROM holes
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `;
}

// Overlap regions = polygonal pairwise intersections of polygons in the source
// table, via a bbox-prefiltered join (PIECEWISE_MERGE_JOIN, not the
// WASM-OOMing SPATIAL_JOIN). ST_Overlaps/ST_Contains, not ST_Intersects,
// which would also match every ordinary touching-edge pair and flood the
// join at admin-boundary scale.
export function overlapRegionsQuery(targetTable: string, sourceTable: string): string {
  return `--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH bboxed AS (
      SELECT fid, geom, ${bboxColumnsSql()}
      FROM ${sourceTable}
    ),
    pairs AS (
      SELECT a.fid AS fa, b.fid AS fb,
             ST_MakeValid(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS geom
      FROM bboxed a JOIN bboxed b
        ON a.fid < b.fid
        AND ${bboxOverlapSql("a", "b")}
        AND (
          ST_Overlaps(a.geom, b.geom)
          OR ST_Contains(a.geom, b.geom)
          OR ST_Contains(b.geom, a.geom)
        )
    )
    SELECT row_number() OVER () AS n, fa, fb, geom
    FROM pairs
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `;
}
