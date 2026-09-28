import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

export type Bounds = [number, number, number, number];

// Extent of a loaded layer's geometry table, or null when it has none.
export async function layerBounds(
  conn: AsyncDuckDBConnection,
  table = "layer_01",
): Promise<Bounds | null> {
  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM ${table} WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  const b: Bounds = [xmin, ymin, xmax, ymax];
  return b.every((v) => Number.isFinite(v)) ? b : null;
}

// Source attributes of the first loaded feature containing a point, as strings.
export async function attributesAt(
  conn: AsyncDuckDBConnection,
  [lng, lat]: [number, number],
): Promise<Record<string, string | null> | null> {
  const r = await conn.query(`--sql
    SELECT a.* EXCLUDE (fid) FROM layer_01 g JOIN layer_attr a USING (fid)
    WHERE ST_Intersects(g.geom, ST_Point(${lng}, ${lat}))
    ORDER BY fid LIMIT 1
  `);
  const row = r.toArray()[0]?.toJSON() as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? null : String(v)]));
}
