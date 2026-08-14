import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  CLIP_TILE_MAX_CELL,
  CLIP_TILE_MIN_CELL,
  CLIP_TILE_MIN_VERTICES,
  CLIP_TILE_TARGET_VERTICES,
} from "./constants";

// Solve a tile size from this parent's own vertex density, not a fixed
// constant. Calibrated (topo-tools-py) so a real worst case (South Africa,
// 281k vertices) lands at ~1 degree cells; sparser or simpler parents get
// coarser cells, denser ones finer.
function adaptiveCellSize(vertexCount: number, width: number, height: number): number {
  const bboxArea = Math.max(width, 1e-9) * Math.max(height, 1e-9);
  const cell = Math.sqrt((CLIP_TILE_TARGET_VERTICES * bboxArea) / vertexCount);
  return Math.min(Math.max(cell, CLIP_TILE_MIN_CELL), CLIP_TILE_MAX_CELL);
}

// Grid-subdivides sourceTable's single-row geometry into outTable, tile by
// tile — below CLIP_TILE_MIN_VERTICES, outTable just gets the geometry
// directly (no subdivision needed). Ported from topo-tools-py's
// core/clip/_tiling.py subdivide_boundary; shared by clip and mosaic (see
// docs/adr/0025 for why this stays a WASM-safe direct port rather than
// needing worker isolation).
export async function subdivideBoundary(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  geomCol: string,
  outTable: string,
): Promise<void> {
  const bboxRow = (
    await conn.query(`--sql
      SELECT ST_XMin(${geomCol}) AS x0, ST_YMin(${geomCol}) AS y0,
             ST_XMax(${geomCol}) AS x1, ST_YMax(${geomCol}) AS y1,
             ST_NPoints(${geomCol}) AS n
      FROM ${sourceTable}
    `)
  ).toArray()[0] as { x0: number; y0: number; x1: number; y1: number; n: bigint | number };
  const { x0, y0, x1, y1 } = bboxRow;
  const vertexCount = Number(bboxRow.n ?? 0);

  if (vertexCount < CLIP_TILE_MIN_VERTICES) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${outTable} AS
      SELECT ${geomCol} AS geom FROM ${sourceTable}
    `);
    return;
  }

  const cell = adaptiveCellSize(vertexCount, x1 - x0, y1 - y0);
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell));

  const occupiedRows = (
    await conn.query(`--sql
      WITH parts AS (
        SELECT UNNEST(ST_Dump(${geomCol})).geom AS g FROM ${sourceTable}
      )
      SELECT DISTINCT UNNEST(range(
        CAST(floor((ST_XMin(g) - ${x0}) / ${cell}) AS INTEGER),
        CAST(floor((ST_XMax(g) - ${x0}) / ${cell}) AS INTEGER) + 1
      )) AS i
      FROM parts ORDER BY i
    `)
  ).toArray() as Array<{ i: bigint | number }>;

  await conn.query(`CREATE OR REPLACE TABLE ${outTable} (geom GEOMETRY)`);
  for (const row of occupiedRows) {
    const i = Number(row.i);
    const sx0 = x0 + i * cell;
    const sx1 = x0 + (i + 1) * cell;
    await conn.query(`--sql
      INSERT INTO ${outTable}
      WITH strip AS (
        SELECT ST_Intersection(${geomCol}, ST_MakeEnvelope(${sx0}, ${y0}, ${sx1}, ${y1})) AS g
        FROM ${sourceTable}
      ),
      gy AS (
        SELECT ${y0} + j * ${cell} AS cy0, ${y0} + (j + 1) * ${cell} AS cy1
        FROM (SELECT UNNEST(range(${ny})) AS j)
      )
      SELECT geom FROM (
        SELECT ST_Intersection(strip.g, ST_MakeEnvelope(${sx0}, gy.cy0, ${sx1}, gy.cy1)) AS geom
        FROM strip, gy
        WHERE NOT ST_IsEmpty(strip.g)
      ) WHERE NOT ST_IsEmpty(geom)
    `);
  }
}
