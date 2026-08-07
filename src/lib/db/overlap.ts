import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Overlap measurement robust to a WASM-only GEOS OverlayNG bug: exact
// ST_Intersection/ST_Difference can throw on near-coincident boundaries, so this falls back to point sampling (which can't fail) when that happens.

export type OverlapMethod = "exact" | "sampling";

const SLIVER = 1e-12; // drop intersection crumbs below ~1 cm² (in deg²)

// GRID×GRID lattice per polygon, plus a guaranteed ST_PointOnSurface so
// small/thin units are never dropped; 32 was chosen by calibrating sampled IoU against exact overlay.
const GRID = 32;

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

async function computeExact(
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

async function samplePoints(
  conn: AsyncDuckDBConnection,
  table: string,
  ptsTable: string,
): Promise<void> {
  await conn.query(`--sql
    CREATE TABLE ${ptsTable} AS
    WITH bbox AS (
      SELECT fid, geom,
             ST_XMin(geom) AS x0, ST_XMax(geom) AS x1,
             ST_YMin(geom) AS y0, ST_YMax(geom) AS y1
      FROM ${table}
    ),
    grid AS (
      SELECT fid, geom,
             ST_Point(x0 + (i + 0.5) * (x1 - x0) / ${GRID},
                      y0 + (j + 0.5) * (y1 - y0) / ${GRID}) AS pt
      FROM bbox,
           UNNEST(range(0, ${GRID})) AS gx(i),
           UNNEST(range(0, ${GRID})) AS gy(j)
    )
    SELECT fid AS self_fid, pt FROM grid WHERE ST_Within(pt, geom)
    UNION ALL
    SELECT fid AS self_fid, ST_PointOnSurface(geom) AS pt FROM ${table}
  `);
}

async function computeSampling(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  pairsTable: string,
): Promise<void> {
  const aPts = `${pairsTable}_a_pts`;
  const bPts = `${pairsTable}_b_pts`;
  const aAreas = `${pairsTable}_a_areas`;
  const bAreas = `${pairsTable}_b_areas`;

  for (const t of [aPts, bPts, aAreas, bAreas, pairsTable]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }

  await conn.query(`CREATE TABLE ${aAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${aTable}`);
  await conn.query(`CREATE TABLE ${bAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${bTable}`);

  await samplePoints(conn, aTable, aPts);
  await samplePoints(conn, bTable, bPts);

  await withLooseMemoryLimit(conn, async () => {
    await conn.query(`--sql
      CREATE TABLE ${pairsTable} AS
      WITH
      a_total AS (SELECT self_fid AS a_fid, COUNT(*) AS n FROM ${aPts} GROUP BY self_fid),
      b_total AS (SELECT self_fid AS b_fid, COUNT(*) AS n FROM ${bPts} GROUP BY self_fid),
      a_hits AS (
        SELECT p.self_fid AS a_fid, o.fid AS b_fid, COUNT(*) AS c
        FROM ${aPts} p JOIN ${bTable} o ON ST_Within(p.pt, o.geom)
        GROUP BY p.self_fid, o.fid
      ),
      b_hits AS (
        SELECT o.fid AS a_fid, p.self_fid AS b_fid, COUNT(*) AS c
        FROM ${bPts} p JOIN ${aTable} o ON ST_Within(p.pt, o.geom)
        GROUP BY o.fid, p.self_fid
      ),
      pair_keys AS (
        SELECT a_fid, b_fid FROM a_hits
        UNION
        SELECT a_fid, b_fid FROM b_hits
      ),
      raw AS (
        SELECT
          k.a_fid, k.b_fid,
          COALESCE(ah.c, 0)::DOUBLE / atot.n * aa.area AS shared_area,
          COALESCE(ah.c, 0)::DOUBLE / atot.n          AS coverage_a,
          COALESCE(bh.c, 0)::DOUBLE / btot.n          AS coverage_b,
          aa.area AS area_a, ba.area AS area_b
        FROM pair_keys k
        JOIN a_total atot ON atot.a_fid = k.a_fid
        JOIN b_total btot ON btot.b_fid = k.b_fid
        JOIN ${aAreas} aa ON aa.fid = k.a_fid
        JOIN ${bAreas} ba ON ba.fid = k.b_fid
        LEFT JOIN a_hits ah ON ah.a_fid = k.a_fid AND ah.b_fid = k.b_fid
        LEFT JOIN b_hits bh ON bh.a_fid = k.a_fid AND bh.b_fid = k.b_fid
      )
      SELECT a_fid, b_fid, shared_area, coverage_a, coverage_b,
             shared_area / NULLIF(area_a + area_b - shared_area, 0) AS iou
      FROM raw
    `);
  });

  for (const t of [aPts, bPts, aAreas, bAreas]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

export async function computeOverlapPairs(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  pairsTable: string,
  onAttempt?: (method: OverlapMethod) => void,
): Promise<OverlapMethod> {
  onAttempt?.("exact");
  try {
    await computeExact(conn, aTable, bTable, pairsTable);
    return "exact";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`exact overlay failed (WASM OverlayNG); falling back to point sampling: ${msg}`);
    onAttempt?.("sampling");
    await computeSampling(conn, aTable, bTable, pairsTable);
    return "sampling";
  }
}
