import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { NODING_FALLBACK_GRID, SNAP_TOLERANCE } from "./constants";
import { intersectPairs } from "./overlap";

export async function emptyRegions(
  conn: AsyncDuckDBConnection,
  table: string,
  extra = "",
): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TABLE ${table} AS SELECT NULL::BIGINT AS n${extra}, NULL::GEOMETRY AS geom WHERE FALSE`,
  );
}

function gapHolesSql(targetTable: string, sourceTable: string, geomExpr: string): string {
  return `--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH
    union_cte AS (
      SELECT ST_Union_Agg(${geomExpr}) AS u
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

// Gap regions = interior rings of the union of sourceTable's polygons, written
// to targetTable (n, geom). When the exact union throws, the union is retried
// on a fine grid and a hole whose interior point an input polygon covers is a
// grid artifact, dropped.
export async function buildGapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  try {
    await conn.query(gapHolesSql(targetTable, sourceTable, "geom"));
    return;
  } catch (e) {
    console.warn(`gap union failed; retrying on a ${NODING_FALLBACK_GRID} grid:`, e);
  }
  const holes = `${targetTable}_grid_holes`;
  const source = `${targetTable}_grid_source`;
  try {
    await conn.query(
      gapHolesSql(holes, sourceTable, `ST_ReducePrecision(geom, ${NODING_FALLBACK_GRID})`),
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${source} AS
      SELECT geom, ${bboxColumnsSql()} FROM ${sourceTable}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      WITH pts AS (
        SELECT n, geom, ST_PointOnSurface(geom) AS p FROM ${holes}
      ),
      probes AS (
        SELECT n, p, ST_X(p) AS xmin, ST_X(p) AS xmax, ST_Y(p) AS ymin, ST_Y(p) AS ymax
        FROM pts
      ),
      covered AS (
        SELECT DISTINCT h.n FROM probes h JOIN ${source} s
          ON ${bboxOverlapSql("h", "s")} AND ST_Intersects(s.geom, h.p)
      )
      SELECT row_number() OVER (ORDER BY n) AS n, geom
      FROM pts WHERE n NOT IN (SELECT n FROM covered)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${holes}`);
    await conn.query(`DROP TABLE IF EXISTS ${source}`);
  }
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
    await buildGapTable(conn, scratch, sourceTable);
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

// Overlap regions = polygonal pairwise intersections of sourceTable's polygons,
// written to targetTable (n, fa, fb, geom). ST_Overlaps/ST_Contains, not
// ST_Intersects, which would also match every ordinary touching-edge pair.
export async function buildOverlapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  const bboxed = `${targetTable}_bbox`;
  const pieces = `${targetTable}_pieces`;
  await conn.query(
    `CREATE OR REPLACE TABLE ${bboxed} AS SELECT fid AS id, geom, ${bboxColumnsSql()} FROM ${sourceTable}`,
  );
  try {
    await intersectPairs(
      conn,
      "buildOverlapTable",
      bboxed,
      bboxed,
      pieces,
      `a.id < b.id AND (ST_Overlaps(a.geom, b.geom) OR ST_Contains(a.geom, b.geom) OR ST_Contains(b.geom, a.geom))`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT row_number() OVER () AS n, a_id AS fa, b_id AS fb, geom
      FROM ${pieces}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${bboxed}`);
    await conn.query(`DROP TABLE IF EXISTS ${pieces}`);
  }
}
