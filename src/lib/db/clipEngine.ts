import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "./bbox";
import { subdivideBoundary } from "./clipTiling";
import { mergeDetachedParts } from "./coverage";
import { intersectPairs } from "./overlap";

export interface ClipEngineResult {
  outputCount: number;
  emptyCount: number; // rows dropped because their clip result was empty
}

// Clips every (fid, geom) row of `sourceSql` to the single polygon `boundarySql`
// selects, writing (fid, geom) to `targetTable`, adaptively grid-tiling the
// boundary first if it's large. Ported from topo-tools-py's core/clip/_engine.py,
// minus the per-overlay-fid subprocess isolation (unneeded in WASM, see
// docs/adr/0025): every caller clips against exactly one known boundary.
export async function clipEngine(
  conn: AsyncDuckDBConnection,
  sourceSql: string,
  boundarySql: string,
  targetTable: string,
): Promise<ClipEngineResult> {
  await conn.query(`CREATE OR REPLACE TABLE cl_overlay_one AS SELECT geom FROM (${boundarySql})`);
  await subdivideBoundary(conn, "cl_overlay_one", "geom", "cl_btile_raw");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_btile AS
    SELECT ROW_NUMBER() OVER () AS id, geom, ${bboxColumnsSql("geom")} FROM cl_btile_raw
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_input_bbox AS
    SELECT fid AS id, geom, ${bboxColumnsSql("geom")} FROM (${sourceSql})
  `);

  await intersectPairs(conn, "clipEngine", "cl_input_bbox", "cl_btile", "cl_clip_pieces");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    SELECT * FROM (
      SELECT a_id AS fid, ST_Multi(ST_CollectionExtract(ST_Union_Agg(geom), 3)) AS geom
      FROM cl_clip_pieces
      GROUP BY a_id
    ) WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  await conn.query("DROP TABLE IF EXISTS cl_clip_pieces");

  await conn.query("DROP TABLE IF EXISTS cl_overlay_one");
  await conn.query("DROP TABLE IF EXISTS cl_btile_raw");
  await conn.query("DROP TABLE IF EXISTS cl_btile");

  const [outputRes, assignedRes] = await Promise.all([
    conn.query(`SELECT COUNT(*) AS n FROM ${targetTable}`),
    conn.query("SELECT COUNT(*) AS n FROM cl_input_bbox"),
  ]);
  const outputCount = Number((outputRes.toArray()[0] as { n: bigint | number }).n);
  const assignedCount = Number((assignedRes.toArray()[0] as { n: bigint | number }).n);

  await conn.query("DROP TABLE IF EXISTS cl_input_bbox");

  return { outputCount, emptyCount: Math.max(0, assignedCount - outputCount) };
}

// Clip and Mosaic's detached-piece pass over cl_clip (cl_assign's input
// features clipped to one overlay feature), writing cl_detached.
export async function mergeClipDetached(
  conn: AsyncDuckDBConnection,
  overlayFid: number,
  hasOriginal: boolean,
): Promise<{ merged: number; kept: number }> {
  const merged = await mergeDetachedParts(conn, "cl_clip", "cl_clip", {
    preClipSql:
      "SELECT c.fid, c.geom FROM input_layer_01 c JOIN cl_assign a ON a.input_fid = c.fid",
    overlaySql: `SELECT geom FROM overlay_layer_01 WHERE fid = ${overlayFid}`,
    overlayFid,
    originalTable: hasOriginal ? "original_layer_01" : null,
    issuesTable: "cl_detached",
  });
  const r = await conn.query("SELECT COUNT(*) AS n FROM cl_detached");
  return { merged, kept: Number((r.toArray()[0] as { n: bigint | number }).n) - merged };
}
