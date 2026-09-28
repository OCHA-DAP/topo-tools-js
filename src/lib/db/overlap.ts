import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { SNAP_TOLERANCE } from "./constants";

// Drop intersection crumbs below SNAP_TOLERANCE², in deg² (matches topo-tools-py ADR-0030).
// Shared with polygon-changelog/pipeline/overlay.ts's own difference-crumb filter.
export const SLIVER = SNAP_TOLERANCE ** 2;

const AREA = (g: string) => `ST_Area(ST_Transform(${g}, 'EPSG:4326', 'EPSG:8857'))`;

async function withLooseMemoryLimit<T>(
  conn: AsyncDuckDBConnection,
  fn: () => Promise<T>,
): Promise<T> {
  // ST_Intersects/ST_Within in a JOIN ON triggers DuckDB's SPATIAL_JOIN, which
  // pre-reserves ~1x memory_limit; loosen it for the join and restore after.
  const prevMem = (
    (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0] as {
      v: string;
    }
  ).v;
  await conn.query("SET memory_limit = '999GB'");
  try {
    return await fn();
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }
}

const INTERSECTION = (a: string, b: string) =>
  `ST_MakeValid(ST_CollectionExtract(ST_Intersection(${a}, ${b}), 3))`;

// Per-pair rebuild of `overlapTable` after the set-based intersection throws: a pair
// that still throws is retried with `a` snapped onto `b`. Returns the snapped count.
async function intersectPairwise(
  conn: AsyncDuckDBConnection,
  aBbox: string,
  bBbox: string,
  overlapTable: string,
): Promise<number> {
  const candidates = (
    await conn.query(`--sql
      SELECT a.fid AS a_fid, b.fid AS b_fid FROM ${aBbox} a JOIN ${bBbox} b
        ON ${bboxOverlapSql("a", "b")} AND ST_Intersects(a.geom, b.geom)
    `)
  ).toArray() as Array<{ a_fid: bigint | number; b_fid: bigint | number }>;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${overlapTable} (a_fid BIGINT, b_fid BIGINT, geom GEOMETRY)
  `);
  let snapped = 0;
  for (const { a_fid: aFid, b_fid: bFid } of candidates) {
    const insert = (aGeom: string) => `--sql
      INSERT INTO ${overlapTable}
      SELECT a.fid, b.fid, ${INTERSECTION(aGeom, "b.geom")}
      FROM ${aBbox} a, ${bBbox} b WHERE a.fid = ${aFid} AND b.fid = ${bFid}
    `;
    try {
      await conn.query(insert("a.geom"));
    } catch {
      await conn.query(insert(`ST_Snap(a.geom, b.geom, ${SNAP_TOLERANCE})`));
      snapped++;
    }
  }
  return snapped;
}

// Computes, for every intersecting (a_fid, b_fid) pair, the shared area
// (equal-area EPSG:8857) plus each side's coverage fraction and IoU. Writes
// `pairsTable`, logging how many pairs needed the snapped fallback.
export async function computeOverlapPairs(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  pairsTable: string,
): Promise<void> {
  const overlapTable = `${pairsTable}_overlap`;
  const aBbox = `${pairsTable}_a_bbox`;
  const bBbox = `${pairsTable}_b_bbox`;
  const aAreas = `${pairsTable}_a_areas`;
  const bAreas = `${pairsTable}_b_areas`;
  const pairAreas = `${pairsTable}_pair_areas`;

  // Bbox-prefiltered (not a plain ST_Intersects self-join) so a heavy parent
  // table doesn't choke DuckDB's SPATIAL_JOIN plan; see $lib/db/bbox.
  await conn.query(
    `CREATE OR REPLACE TABLE ${aBbox} AS SELECT fid, geom, ${bboxColumnsSql()} FROM ${aTable}`,
  );
  await conn.query(
    `CREATE OR REPLACE TABLE ${bBbox} AS SELECT fid, geom, ${bboxColumnsSql()} FROM ${bTable}`,
  );

  await conn.query(`DROP TABLE IF EXISTS ${overlapTable}`);
  let snapped = 0;
  await withLooseMemoryLimit(conn, async () => {
    try {
      await conn.query(`--sql
        CREATE TABLE ${overlapTable} AS
        SELECT a.fid AS a_fid, b.fid AS b_fid, ${INTERSECTION("a.geom", "b.geom")} AS geom
        FROM ${aBbox} a JOIN ${bBbox} b
          ON ${bboxOverlapSql("a", "b")}
         AND ST_Intersects(a.geom, b.geom)
      `);
    } catch {
      // WASM GEOS throws "non-noded intersection" on some near-coincident edges.
      snapped = await intersectPairwise(conn, aBbox, bBbox, overlapTable);
    }
    await conn.query(
      `DELETE FROM ${overlapTable} WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`,
    );
  });
  await conn.query(`DROP TABLE IF EXISTS ${aBbox}`);
  await conn.query(`DROP TABLE IF EXISTS ${bBbox}`);

  for (const t of [aAreas, bAreas, pairAreas, pairsTable]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await conn.query(`CREATE TABLE ${aAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${aTable}`);
  await conn.query(`CREATE TABLE ${bAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${bTable}`);
  await conn.query(`--sql
    CREATE TABLE ${pairAreas} AS
    SELECT a_fid, b_fid, SUM(${AREA("geom")}) AS shared_area
    FROM ${overlapTable} GROUP BY a_fid, b_fid
  `);
  await conn.query(`--sql
    CREATE TABLE ${pairsTable} AS
    SELECT p.a_fid, p.b_fid, p.shared_area,
           p.shared_area / NULLIF(aa.area, 0)                           AS coverage_a,
           p.shared_area / NULLIF(ba.area, 0)                           AS coverage_b,
           p.shared_area / NULLIF(aa.area + ba.area - p.shared_area, 0) AS iou
    FROM ${pairAreas} p
    JOIN ${aAreas} aa ON aa.fid = p.a_fid
    JOIN ${bAreas} ba ON ba.fid = p.b_fid
  `);

  await conn.query(`DROP TABLE IF EXISTS ${overlapTable}`);
  await conn.query(`DROP TABLE IF EXISTS ${aAreas}`);
  await conn.query(`DROP TABLE IF EXISTS ${bAreas}`);
  await conn.query(`DROP TABLE IF EXISTS ${pairAreas}`);
  if (snapped > 0)
    console.warn(`computeOverlapPairs: ${snapped} pair(s) intersected after snapping`);
}
