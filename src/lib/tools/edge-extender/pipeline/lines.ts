import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

export async function stageLines(conn: AsyncDuckDBConnection): Promise<void> {
  console.log("[EE-DEBUG] lines:1 boundary (layer_02_tmp1)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_02_tmp1 AS
    SELECT fid, ST_Boundary(geom) AS geom FROM layer_01
  `);

  // Per-polygon neighbor union via bbox self-join. Scalar bbox predicates plan
  // as PIECEWISE_MERGE_JOIN, avoiding SPATIAL_JOIN's ~1× RAM virtual reservation.
  // Bbox-only is correct: a non-touching neighbor adds nothing to ST_Difference
  // / ST_Intersection against a's boundary.
  console.log("[EE-DEBUG] lines:2 neighbor union (layer_02_tmp2)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_02_tmp2 AS
    SELECT a.fid AS afid, ST_Union_Agg(b.geom) AS neighbor_union
    FROM layer_02_tmp1 AS a
    JOIN layer_02_tmp1 AS b
      ON a.fid != b.fid
     AND ST_XMax(b.geom) >= ST_XMin(a.geom)
     AND ST_XMin(b.geom) <= ST_XMax(a.geom)
     AND ST_YMax(b.geom) >= ST_YMin(a.geom)
     AND ST_YMin(b.geom) <= ST_YMax(a.geom)
    GROUP BY a.fid
  `);

  console.log("[EE-DEBUG] lines:3 difference+linemerge (layer_02a)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_02a AS
    SELECT
      a.fid,
      UNNEST(ST_Dump(ST_LineMerge(ST_CollectionExtract(
        CASE WHEN n.neighbor_union IS NOT NULL
             THEN ST_Difference(a.geom, n.neighbor_union)
             ELSE a.geom
        END, 2
      )))).geom AS geom
    FROM layer_02_tmp1 AS a
    LEFT JOIN layer_02_tmp2 AS n ON a.fid = n.afid
  `);
  console.log("[EE-DEBUG] lines:4 done, dropping tmp tables");

  await conn.query("DROP TABLE IF EXISTS layer_02_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_02_tmp2");
}
