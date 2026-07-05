import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageClean } from "$lib/db/coverageClean";

const SNAP_TOLERANCE = 1e-8;

export async function stageMerge(conn: AsyncDuckDBConnection): Promise<void> {
  // Per-part layer_01 with bbox columns. Parts (not whole multi-part fids) keep
  // the bbox tight — a fid spanning mainland to a remote island would otherwise
  // make a whole-fid bbox match nearly everything nearby.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp1 AS
    WITH parts AS (
      SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM layer_01
    )
    SELECT fid, part_geom,
      ST_XMin(part_geom) AS xmin, ST_XMax(part_geom) AS xmax,
      ST_YMin(part_geom) AS ymin, ST_YMax(part_geom) AS ymax
    FROM parts
  `);

  // Original rows, UNION ALL each fid's non-empty Voronoi-cell remainder
  // (the cell minus everything already covered by a nearby original polygon).
  // A single ST_Union_Agg(layer_01) as one global blob used as a per-fid
  // ST_Difference operand OOMs at large scale — bbox-prefiltered self-join per
  // cell against nearby parts only, same pattern lines.ts uses for its
  // neighbor-union join.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp2 AS
    WITH
    v AS (
      SELECT fid, geom,
        ST_XMin(geom) AS xmin, ST_XMax(geom) AS xmax,
        ST_YMin(geom) AS ymin, ST_YMax(geom) AS ymax
      FROM layer_04
    ),
    neighbor_union AS (
      SELECT v.fid AS vfid, ST_Union_Agg(p.part_geom) AS geom
      FROM v
      JOIN layer_05_tmp1 p
        ON p.xmax >= v.xmin AND p.xmin <= v.xmax
       AND p.ymax >= v.ymin AND p.ymin <= v.ymax
      GROUP BY v.fid
    ),
    remainder AS (
      SELECT v.fid,
        ST_MakeValid(ST_CollectionExtract(
          CASE WHEN n.geom IS NOT NULL
               THEN ST_Difference(v.geom, n.geom)
               ELSE v.geom
          END, 3
        )) AS geom
      FROM v
      LEFT JOIN neighbor_union n ON v.fid = n.vfid
    )
    SELECT fid, geom FROM layer_01
    UNION ALL
    SELECT fid, geom FROM remainder WHERE NOT ST_IsEmpty(geom)
  `);

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_04");

  // Dissolve original + extension pieces to one row per fid.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp3 AS
    SELECT fid, ST_Union_Agg(geom) AS geom
    FROM layer_05_tmp2
    GROUP BY fid
  `);

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp2");

  // Single whole-table coverage clean closes floating-point-scale seams left by
  // the independent per-fid ST_Difference calls above (GEOS recomputes crossing
  // points slightly differently each time). gap is tied to SNAP_TOLERANCE, not
  // a sliver-vs-real-hole heuristic: by construction every point of the extent
  // belongs to exactly one fid here, so anything CoverageClean finds to close
  // is seam noise, not a real gap. preserveOriginal keeps merge from ever
  // dropping a fid outright if CoverageClean collapses it.
  await buildCoverageClean(conn, "layer_05_tmp3", "layer_05", {
    gap: SNAP_TOLERANCE,
    preserveOriginal: true,
  });

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp3");
}
