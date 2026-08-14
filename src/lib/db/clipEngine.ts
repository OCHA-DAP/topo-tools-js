import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { subdivideBoundary } from "./clipTiling";

export interface ClipEngineResult {
  outputCount: number;
  emptyCount: number; // rows dropped because their clip result was empty
}

// Clips every child in cl_assign to parentFid's own geometry, adaptively
// grid-tiling the parent boundary first if it's large — ported from
// topo-tools-py's core/clip/_engine.py, minus the per-parent-fid subprocess
// isolation (unneeded in WASM, see docs/adr/0025) and minus the per-fid
// loop itself: both clip and mosaic (the only two callers) work from a
// single-children-upload scope, so assignOne always produces exactly one
// winner parent (see docs/adr/0026), and there is only ever one parent
// geometry to tile and clip against.
export async function clipEngine(
  conn: AsyncDuckDBConnection,
  parentFid: number,
): Promise<ClipEngineResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_parent_one AS
    SELECT geom FROM parent_layer_01 WHERE fid = ${parentFid}
  `);
  await subdivideBoundary(conn, "cl_parent_one", "geom", "cl_btile_raw");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_btile AS
    SELECT geom, ${bboxColumnsSql("geom")} FROM cl_btile_raw
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_child_bbox AS
    SELECT ch.fid, ch.geom, ${bboxColumnsSql("ch.geom")}
    FROM child_layer_01 ch
    JOIN cl_assign a ON a.child_fid = ch.fid
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_clip AS
    SELECT * FROM (
      SELECT c.fid,
             ST_Multi(ST_CollectionExtract(ST_Union_Agg(ST_Intersection(c.geom, b.geom)), 3)) AS geom
      FROM cl_child_bbox c
      JOIN cl_btile b ON ${bboxOverlapSql("c", "b")}
      GROUP BY c.fid
    ) WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);

  await conn.query("DROP TABLE IF EXISTS cl_parent_one");
  await conn.query("DROP TABLE IF EXISTS cl_btile_raw");
  await conn.query("DROP TABLE IF EXISTS cl_btile");

  const [outputRes, assignedRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM cl_clip"),
    conn.query("SELECT COUNT(*) AS n FROM cl_child_bbox"),
  ]);
  const outputCount = Number((outputRes.toArray()[0] as { n: bigint | number }).n);
  const assignedCount = Number((assignedRes.toArray()[0] as { n: bigint | number }).n);

  await conn.query("DROP TABLE IF EXISTS cl_child_bbox");

  return { outputCount, emptyCount: Math.max(0, assignedCount - outputCount) };
}
