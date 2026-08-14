import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
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

// Computes, for every intersecting (a_fid, b_fid) pair, the shared area
// (equal-area EPSG:8857) plus each side's coverage fraction and IoU. Writes
// `pairsTable`.
export async function computeOverlapPairs(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  pairsTable: string,
): Promise<void> {
  const overlapTable = `${pairsTable}_overlap`;
  const aAreas = `${pairsTable}_a_areas`;
  const bAreas = `${pairsTable}_b_areas`;
  const pairAreas = `${pairsTable}_pair_areas`;

  await conn.query(`DROP TABLE IF EXISTS ${overlapTable}`);
  await withLooseMemoryLimit(conn, async () => {
    await conn.query(`--sql
      CREATE TABLE ${overlapTable} AS
      SELECT a.fid AS a_fid, b.fid AS b_fid,
             ST_MakeValid(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS geom
      FROM ${aTable} a JOIN ${bTable} b ON ST_Intersects(a.geom, b.geom)
    `);
    await conn.query(
      `DELETE FROM ${overlapTable} WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`,
    );
  });

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
}
