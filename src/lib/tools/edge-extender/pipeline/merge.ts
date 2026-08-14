import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "$lib/db/bbox";
import { SNAP_TOLERANCE } from "$lib/db/constants";

export async function stageMerge(conn: AsyncDuckDBConnection): Promise<void> {
  // Per-part layer_01 with bbox columns. Parts (not whole multi-part fids) keep
  // the bbox tight — a fid spanning mainland to a remote island would otherwise
  // make a whole-fid bbox match nearly everything nearby.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp1 AS
    WITH parts AS (
      SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM layer_01
    )
    SELECT fid, part_geom, ${bboxColumnsSql("part_geom")}
    FROM parts
  `);

  // Original rows, UNION ALL each fid's non-empty Voronoi-cell remainder (the
  // cell minus everything already covered by a nearby original polygon).
  // Snapping the cell onto its neighbor union's real vertices before
  // differencing lets GEOS see a near-miss crossing as a proper touch,
  // shrinking how much float-noise the final whole-table CoverageClean pass
  // has to fix. A single ST_Union_Agg(layer_01) as one global blob used as a
  // per-fid ST_Difference operand OOMs at large scale — bbox-prefiltered
  // self-join per cell against nearby parts only, same pattern lines.ts uses
  // for its neighbor-union join.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp2 AS
    WITH
    v AS (
      SELECT fid, geom, ${bboxColumnsSql()}
      FROM layer_04
    ),
    neighbor_union AS (
      SELECT v.fid AS vfid, ST_Union_Agg(p.part_geom) AS geom
      FROM v
      JOIN layer_05_tmp1 p
        ON ${bboxOverlapSql("v", "p")}
      GROUP BY v.fid
    ),
    snapped AS (
      SELECT v.fid,
        CASE WHEN n.geom IS NOT NULL
             THEN ST_Snap(v.geom, n.geom, ${SNAP_TOLERANCE})
             ELSE v.geom
        END AS geom,
        n.geom AS neighbor_geom
      FROM v
      LEFT JOIN neighbor_union n ON v.fid = n.vfid
    ),
    remainder AS (
      SELECT fid,
        ST_MakeValid(ST_CollectionExtract(
          CASE WHEN neighbor_geom IS NOT NULL
               THEN ST_Difference(geom, neighbor_geom)
               ELSE geom
          END, 3
        )) AS geom
      FROM snapped
    )
    SELECT fid, geom FROM layer_01
    UNION ALL
    SELECT fid, geom FROM remainder WHERE NOT ST_IsEmpty(geom)
  `);

  // Dissolve original + extension pieces to one row per fid via a direct
  // polygon union — a boundary+node+ST_BuildArea reconstruction was tried
  // instead but could invert a real polygon into a spurious interior hole.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05 AS
    SELECT fid, ST_Union_Agg(geom) AS geom
    FROM layer_05_tmp2
    GROUP BY fid
  `);

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_04");
  await conn.query("DROP TABLE IF EXISTS layer_05_tmp2");
}
