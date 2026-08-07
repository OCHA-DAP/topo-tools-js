import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// A∖B / B∖A difference geometry for rendering, separate from the shared
// overlap-pairs computation; only meaningful on the exact path (sampling only estimates ratios, not real geometry).

const SLIVER = 1e-12; // drop difference crumbs below ~1 cm² (in deg²)

export async function stageOverlayDifferences(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS cw_a_only`);
  await conn.query(`DROP TABLE IF EXISTS cw_b_only`);

  const prevMem = (
    (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0] as { v: string }
  ).v;
  await conn.query("SET memory_limit = '999GB'");
  try {
    await conn.query(`--sql
      CREATE TABLE cw_a_only AS
      WITH partners AS (
        SELECT a.fid AS a_fid, ST_Union_Agg(b.geom) AS pgeom
        FROM cw_a_keyed a JOIN cw_b_keyed b ON ST_Intersects(a.geom, b.geom)
        GROUP BY a.fid
      )
      SELECT a.fid AS a_fid,
             ST_CollectionExtract(ST_MakeValid(
               CASE WHEN p.pgeom IS NULL THEN a.geom ELSE ST_Difference(a.geom, p.pgeom) END), 3) AS geom
      FROM cw_a_keyed a LEFT JOIN partners p ON p.a_fid = a.fid
    `);
    await conn.query(`DELETE FROM cw_a_only WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`);

    await conn.query(`--sql
      CREATE TABLE cw_b_only AS
      WITH partners AS (
        SELECT b.fid AS b_fid, ST_Union_Agg(a.geom) AS pgeom
        FROM cw_b_keyed b JOIN cw_a_keyed a ON ST_Intersects(b.geom, a.geom)
        GROUP BY b.fid
      )
      SELECT b.fid AS b_fid,
             ST_CollectionExtract(ST_MakeValid(
               CASE WHEN p.pgeom IS NULL THEN b.geom ELSE ST_Difference(b.geom, p.pgeom) END), 3) AS geom
      FROM cw_b_keyed b LEFT JOIN partners p ON p.b_fid = b.fid
    `);
    await conn.query(`DELETE FROM cw_b_only WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`);
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }
}
