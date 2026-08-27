import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { SNAP_TOLERANCE } from "./constants";

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

// True if sourceTable's coverage has an interior hole at or below maxWidth
// (degrees) — mirrors topo-tools-py's has_gaps(gap_maximum_width=...).
// sourceTable is expected to already have been cleaned with a matching
// gap-fill width, so a hole this small surviving means the fill silently
// failed; a wider hole may be a legitimate feature (see docs/adr/0028) and
// isn't flagged by this check.
export async function hasNoiseFloorGap(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  maxWidth: number = SNAP_TOLERANCE,
): Promise<boolean> {
  const scratch = `${sourceTable}_noise_gap_check`;
  try {
    await conn.query(gapRegionsQuery(scratch, sourceTable));
    const r = await conn.query(`--sql
      SELECT EXISTS (
        SELECT 1 FROM ${scratch}
        WHERE (ST_MaximumInscribedCircle(geom)).radius * 2 <= ${maxWidth}
      ) AS bad
    `);
    return Boolean(r.toArray()[0].bad);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
  }
}

// Ported from topo-tools-py's check_no_erosion; hard error, since a footprint
// shrunk by extend/merge is data loss, not a cosmetic topology defect.
export async function checkNoErosion(
  conn: AsyncDuckDBConnection,
  tableBefore: string,
  tableAfter: string,
  buffer: number = SNAP_TOLERANCE,
): Promise<void> {
  const r = await conn.query(`--sql
    SELECT b.fid AS fid
    FROM ${tableBefore} b
    LEFT JOIN ${tableAfter} a USING (fid)
    WHERE a.geom IS NULL OR NOT ST_Covers(ST_Buffer(a.geom, ${buffer}), b.geom)
  `);
  const rows = r.toArray() as Array<{ fid: bigint | number }>;
  if (rows.length > 0) {
    const fids = rows.map((row) => Number(row.fid));
    const shown = fids.slice(0, 20).join(", ");
    const suffix = fids.length > 20 ? ", ..." : "";
    throw new Error(
      `extension eroded the original footprint of ${fids.length} fid(s): ${shown}${suffix}`,
    );
  }
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
