import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "$lib/db/constants";

// Cap on points generated per real (untouched) boundary segment; bounds the size of the
// largest exactly-collinear point cluster fed to ST_VoronoiDiagram, independent of that
// segment's raw length. 100 was the smallest of several tested values in the Python port
// (100/250/500/1000/2000), with zero downside on files that don't hit the cap.
const MAX_POINTS_PER_SEGMENT = 100;

// Decompose each layer_02a line into its own real vertex-to-vertex segments. No geometry
// alteration — every downstream point stays exactly on the true digitized boundary.
// Independent of distance, so callers build this once and reuse it across the retry loop
// instead of recomputing it on every attempt.
//
// Vertices are extracted via ST_Points/ST_Dump (path-ordered) and paired with LAG() rather
// than repeated ST_PointN(geom, i) calls: ST_PointN re-walks the geometry from its start on
// every call, an O(n^2) blowup at scale. lid (per-line-row, not fid) is required for
// PARTITION BY: a single fid can have multiple disjoint layer_02a pieces (e.g. a multipolygon
// exterior), and partitioning by fid alone would wrongly stitch the last vertex of one piece
// to the first vertex of the next.
export async function buildSegments(conn: AsyncDuckDBConnection): Promise<void> {
  console.log("[EE-DEBUG] points:buildSegments (layer_03_tmp1)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03_tmp1 AS
    WITH lines AS (
      SELECT row_number() OVER () AS lid, fid, geom
      FROM layer_02a
    ), verts AS (
      SELECT
        lid, fid,
        UNNEST(ST_Dump(ST_Points(geom))).geom AS geom,
        UNNEST(ST_Dump(ST_Points(geom))).path[1] AS idx
      FROM lines
    )
    SELECT
      fid,
      ST_MakeLine(prev_geom, geom) AS geom,
      ST_Distance(prev_geom, geom) AS seg_len
    FROM (
      SELECT
        fid, geom,
        LAG(geom) OVER (PARTITION BY lid ORDER BY idx) AS prev_geom
      FROM verts
    )
    WHERE prev_geom IS NOT NULL
  `);
}

// Assumes buildSegments has already created layer_03_tmp1.
export async function stagePoints(conn: AsyncDuckDBConnection, distance: number): Promise<void> {
  const capThreshold = distance * MAX_POINTS_PER_SEGMENT;

  // Buffered union of all line endpoints — marks the shared-boundary zone.
  // Subtracting this zone from interpolated points removes redundant Voronoi
  // generators at junction vertices.
  console.log("[EE-DEBUG] points:1 buffer+union boundary zone (layer_03a)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03a AS
    SELECT ST_Union_Agg(ST_Buffer(ST_Boundary(geom), ${SNAP_TOLERANCE})) AS geom
    FROM layer_02a
  `);

  // Split into "long" real segments (rare — a single one can span many degrees, e.g.
  // Chad/Algeria's straight desert admin lines) and "normal" ones. Long segments get capped
  // interpolation directly. Normal segments are re-merged back into contiguous per-fid lines
  // and resampled with the original whole-line formula — decomposing into per-segment points
  // unconditionally guarantees at least one point per real segment, a floor equal to the
  // file's raw vertex count that doesn't respond to distance. Re-merging normal segments
  // before resampling restores the old arc-length behaviour, which can shrink below the raw
  // vertex count as distance grows, for the overwhelming majority of segments that were never
  // the pathological case to begin with.
  console.log("[EE-DEBUG] points:2 interpolate long segments (layer_03_tmp2)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03_tmp2 AS
    SELECT
      fid,
      ST_LineInterpolatePoints(
        geom,
        GREATEST(
          LEAST(${distance} / seg_len, 1.0),
          1.0 / ${MAX_POINTS_PER_SEGMENT}
        ),
        true
      ) AS geom
    FROM layer_03_tmp1
    WHERE seg_len > ${capThreshold}
  `);

  console.log("[EE-DEBUG] points:3 remerge+interpolate normal segments (layer_03_tmp3)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03_tmp3 AS
    SELECT
      fid,
      ST_LineInterpolatePoints(
        geom,
        LEAST(${distance} / ST_Length(geom), 1.0),
        true
      ) AS geom
    FROM (
      SELECT fid, UNNEST(ST_Dump(ST_LineMerge(ST_Union_Agg(geom)))).geom AS geom
      FROM layer_03_tmp1
      WHERE seg_len <= ${capThreshold}
      GROUP BY fid
    )
  `);

  // Points from both branches, aggregated to one multipoint per fid *before* differencing
  // against the shared-boundary zone — differencing per segment instead of per fid caused a
  // ~240x call-count blowup that OOM'd Indonesia-scale inputs in the Python port. Aggregating
  // first restores the original per-fid call count regardless of segment count.
  console.log("[EE-DEBUG] points:4 union both branches (layer_03_tmp4)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03_tmp4 AS
    SELECT fid, ST_Union_Agg(geom) AS geom FROM (
      SELECT fid, geom FROM layer_03_tmp2
      UNION ALL
      SELECT fid, geom FROM layer_03_tmp3
    )
    GROUP BY fid
  `);

  // Points from above minus the shared-boundary zone, union'd with line endpoints also minus
  // the shared-boundary zone. CROSS JOIN against single-row layer_03a is safe (nested loop, no
  // SPATIAL_JOIN).
  console.log("[EE-DEBUG] points:5 difference vs boundary zone (layer_03b)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_03b AS
    SELECT fid, geom FROM (
      SELECT
        a.fid,
        UNNEST(ST_Dump(ST_Difference(a.geom, b.geom))).geom AS geom
      FROM layer_03_tmp4 AS a
      CROSS JOIN layer_03a AS b
      UNION ALL
      SELECT
        a.fid,
        UNNEST(ST_Dump(ST_Boundary(
          ST_Difference(a.geom, b.geom)
        ))).geom AS geom
      FROM layer_02a AS a
      CROSS JOIN layer_03a AS b
    )
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  console.log("[EE-DEBUG] points:6 done, dropping tmp tables");

  await conn.query("DROP TABLE IF EXISTS layer_03_tmp2");
  await conn.query("DROP TABLE IF EXISTS layer_03_tmp3");
  await conn.query("DROP TABLE IF EXISTS layer_03_tmp4");
}
