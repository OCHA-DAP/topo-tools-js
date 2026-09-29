import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "./bbox";
import { CLIP_TILE_MIN_VERTICES } from "./constants";
import { subdivideBoundary } from "./clipTiling";
import { intersectPairs } from "./overlap";
import {
  type AssignmentMethod,
  type MatchColumnOptions,
  pickFileCodeWinner,
  resolveAssignment,
  resolveMatchColumns,
} from "./codeJoin";

export interface AssignOneResult {
  overlayFid: number;
  assignedCount: number;
  droppedCount: number;
  // Set only when a match column was supplied; see docs/adr/0045.
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

// Ported from topo-tools-py's core/assign/_one.py assign_one, scoped to this
// app's browser paradigm: one input upload is one majority-vote group
// (Python's "one input file"), so there is exactly one winner overlay feature per
// run — see docs/adr/0026. Every input feature overlapping that winner is kept;
// every other input feature (including any that overlap a different overlay feature only) is
// dropped, matching the reference contract's "an input feature that does not agree
// with its file's majority-vote overlay feature MUST be dropped." Shared by clip and
// mosaic, both of which need this same per-file majority-vote assignment
// (mosaic's assign stage is this function called directly, per
// topo-tools-py's own mosaic explanation doc).
export async function assignOne(
  conn: AsyncDuckDBConnection,
  matchColumns: MatchColumnOptions = {},
): Promise<AssignOneResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_input_parts AS
    SELECT ROW_NUMBER() OVER () AS id, fid, geom, ${bboxColumnsSql("geom")}
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS geom FROM input_layer_01)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_overlay_parts AS
    SELECT ROW_NUMBER() OVER () AS part_id, fid, part_geom, ST_NPoints(part_geom) AS n_points
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM overlay_layer_01)
  `);

  // Overlay pieces: light parts as-is, heavy parts grid-tiled (the same tiling
  // clip's own clip step uses) so input features bbox-prefilter against tiles.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_overlay_pieces AS
    SELECT fid AS overlay_fid, part_geom AS geom
    FROM cl_overlay_parts WHERE n_points < ${CLIP_TILE_MIN_VERTICES}
  `);
  const heavyParts = (
    await conn.query(`--sql
      SELECT part_id, fid FROM cl_overlay_parts WHERE n_points >= ${CLIP_TILE_MIN_VERTICES}
    `)
  ).toArray() as Array<{ part_id: bigint | number; fid: bigint | number }>;
  for (const { part_id: partId, fid } of heavyParts) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cl_heavy_src AS
      SELECT part_geom AS geom FROM cl_overlay_parts WHERE part_id = ${partId}
    `);
    await subdivideBoundary(conn, "cl_heavy_src", "geom", "cl_heavy_tiles_raw");
    await conn.query(
      `INSERT INTO cl_overlay_pieces SELECT ${fid} AS overlay_fid, geom FROM cl_heavy_tiles_raw`,
    );
  }
  await conn.query("DROP TABLE IF EXISTS cl_heavy_src");
  await conn.query("DROP TABLE IF EXISTS cl_heavy_tiles_raw");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_overlay_pieces AS
    SELECT ROW_NUMBER() OVER () AS id, overlay_fid, geom, ${bboxColumnsSql("geom")}
    FROM cl_overlay_pieces
  `);

  // Area-weighted overlap per piece pair. A touch-only pair (shared edge or
  // corner) has zero area and is dropped below, matching topo-tools-py's
  // assign_one, which only counts shared_area > 0.
  await intersectPairs(conn, "assignOne", "cl_input_parts", "cl_overlay_pieces", "cl_pairs_geom");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_pairs_raw AS
    SELECT c.fid AS input_fid, p.overlay_fid, ST_Area(g.geom) AS shared_area
    FROM cl_pairs_geom g
    JOIN cl_input_parts c ON c.id = g.a_id
    JOIN cl_overlay_pieces p ON p.id = g.b_id
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs_geom");
  await conn.query("DROP TABLE IF EXISTS cl_overlay_pieces");

  // Aggregate part-level areas up to one row per (input feature, overlay feature) — an input feature
  // with multiple parts overlapping the same overlay feature still counts as one vote
  // — and drop any pair whose total shared area is zero (touch-only).
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_pairs AS
    SELECT input_fid, overlay_fid, SUM(shared_area) AS shared_area
    FROM cl_pairs_raw
    GROUP BY input_fid, overlay_fid
    HAVING SUM(shared_area) > 0
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs_raw");

  const votes = (
    await conn.query(`--sql
      SELECT overlay_fid, COUNT(DISTINCT input_fid) AS n_inputs
      FROM cl_pairs GROUP BY overlay_fid
      ORDER BY n_inputs DESC, overlay_fid ASC
      LIMIT 1
    `)
  ).toArray() as Array<{ overlay_fid: bigint | number; n_inputs: bigint | number }>;

  await conn.query("DROP TABLE IF EXISTS cl_input_parts");
  await conn.query("DROP TABLE IF EXISTS cl_overlay_parts");

  if (votes.length === 0) {
    await conn.query("DROP TABLE IF EXISTS cl_pairs");
    throw new Error("No input features overlap any overlay feature — nothing to clip.");
  }

  const spatialOverlayFid = Number(votes[0].overlay_fid);

  const resolvedCols = resolveMatchColumns(matchColumns);
  let overlayFid = spatialOverlayFid;
  let assignmentMethod: AssignmentMethod | undefined;
  let spatialAgrees: boolean | null | undefined;
  if (resolvedCols) {
    const codeOverlayFid = await pickFileCodeWinner(conn, {
      inputAttrTable: "input_layer_attr",
      overlayAttrTable: "overlay_layer_attr",
      pairsTable: "cl_pairs",
      pairsInputCol: "input_fid",
      pairsOverlayCol: "overlay_fid",
      columns: resolvedCols,
    });
    const outcome = resolveAssignment(codeOverlayFid, spatialOverlayFid);
    overlayFid = outcome.overlayFid;
    assignmentMethod = outcome.assignmentMethod;
    spatialAgrees = outcome.spatialAgrees;
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_assign AS
    SELECT DISTINCT input_fid, ${overlayFid} AS overlay_fid
    FROM cl_pairs WHERE overlay_fid = ${overlayFid}
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs");

  const [assignedRes, totalRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM cl_assign"),
    conn.query("SELECT COUNT(*) AS n FROM input_layer_01"),
  ]);
  const assignedCount = Number((assignedRes.toArray()[0] as { n: bigint | number }).n);
  const totalCount = Number((totalRes.toArray()[0] as { n: bigint | number }).n);

  return {
    overlayFid,
    assignedCount,
    droppedCount: Math.max(0, totalCount - assignedCount),
    assignmentMethod,
    spatialAgrees,
  };
}
