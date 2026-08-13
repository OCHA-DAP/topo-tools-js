import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { CLIP_TILE_MIN_VERTICES } from "./constants";
import { subdivideBoundary } from "./clipTiling";

export interface AssignOneResult {
  parentFid: number;
  assignedCount: number;
  droppedCount: number;
}

// Ported from topo-tools-py's core/assign/_one.py assign_one, scoped to this
// app's browser paradigm: one children upload is one majority-vote group
// (Python's "one children file"), so there is exactly one winner parent per
// run — see docs/adr/0026. Every child overlapping that winner is kept;
// every other child (including any that overlap a different parent only) is
// dropped, matching the reference contract's "a child that does not agree
// with its file's majority-vote parent MUST be dropped." Shared by clip and
// mosaic, both of which need this same per-file majority-vote assignment
// (mosaic's assign stage is this function called directly, per
// topo-tools-py's own mosaic explanation doc).
export async function assignOne(conn: AsyncDuckDBConnection): Promise<AssignOneResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_child_parts AS
    SELECT fid, part_geom, ${bboxColumnsSql("part_geom")}
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM child_layer_01)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_parent_parts AS
    SELECT ROW_NUMBER() OVER () AS part_id, fid, part_geom,
           ST_NPoints(part_geom) AS n_points, ${bboxColumnsSql("part_geom")}
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM parent_layer_01)
  `);

  // Light parent parts: direct bbox-prefiltered overlap test.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_pairs AS
    SELECT DISTINCT c.fid AS child_fid, p.fid AS parent_fid
    FROM cl_child_parts c
    JOIN cl_parent_parts p
      ON ${bboxOverlapSql("c", "p")} AND ST_Intersects(c.part_geom, p.part_geom)
    WHERE p.n_points < ${CLIP_TILE_MIN_VERTICES}
  `);

  // Heavy parent parts: grid-tile first (same tiling clip's own clip step
  // uses), then bbox-prefilter children against tiles instead of the raw
  // possibly-huge part.
  const heavyParts = (
    await conn.query(`--sql
      SELECT part_id, fid FROM cl_parent_parts WHERE n_points >= ${CLIP_TILE_MIN_VERTICES}
    `)
  ).toArray() as Array<{ part_id: bigint | number; fid: bigint | number }>;

  if (heavyParts.length > 0) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cl_parent_tiles (
        parent_fid BIGINT, geom GEOMETRY, xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE
      )
    `);
    for (const { part_id: partId, fid } of heavyParts) {
      await conn.query(`--sql
        CREATE OR REPLACE TABLE cl_heavy_src AS
        SELECT part_geom AS geom FROM cl_parent_parts WHERE part_id = ${partId}
      `);
      await subdivideBoundary(conn, "cl_heavy_src", "geom", "cl_heavy_tiles_raw");
      await conn.query(`--sql
        INSERT INTO cl_parent_tiles
        SELECT ${fid} AS parent_fid, geom, ${bboxColumnsSql("geom")} FROM cl_heavy_tiles_raw
      `);
    }
    await conn.query(`--sql
      INSERT INTO cl_pairs
      SELECT DISTINCT c.fid AS child_fid, t.parent_fid AS parent_fid
      FROM cl_child_parts c
      JOIN cl_parent_tiles t
        ON ${bboxOverlapSql("c", "t")} AND ST_Intersects(c.part_geom, t.geom)
    `);
    await conn.query("DROP TABLE IF EXISTS cl_heavy_src");
    await conn.query("DROP TABLE IF EXISTS cl_heavy_tiles_raw");
    await conn.query("DROP TABLE IF EXISTS cl_parent_tiles");
  }

  const votes = (
    await conn.query(`--sql
      SELECT parent_fid, COUNT(DISTINCT child_fid) AS n_children
      FROM cl_pairs GROUP BY parent_fid
      ORDER BY n_children DESC, parent_fid ASC
      LIMIT 1
    `)
  ).toArray() as Array<{ parent_fid: bigint | number; n_children: bigint | number }>;

  await conn.query("DROP TABLE IF EXISTS cl_child_parts");
  await conn.query("DROP TABLE IF EXISTS cl_parent_parts");

  if (votes.length === 0) {
    await conn.query("DROP TABLE IF EXISTS cl_pairs");
    throw new Error("No children overlap any parent unit — nothing to clip.");
  }

  const parentFid = Number(votes[0].parent_fid);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_assign AS
    SELECT DISTINCT child_fid, ${parentFid} AS parent_fid
    FROM cl_pairs WHERE parent_fid = ${parentFid}
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs");

  const [assignedRes, totalRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM cl_assign"),
    conn.query("SELECT COUNT(*) AS n FROM child_layer_01"),
  ]);
  const assignedCount = Number((assignedRes.toArray()[0] as { n: bigint | number }).n);
  const totalCount = Number((totalRes.toArray()[0] as { n: bigint | number }).n);

  return { parentFid, assignedCount, droppedCount: Math.max(0, totalCount - assignedCount) };
}
