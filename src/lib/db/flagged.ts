import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import { queryToGeoJSON } from "$lib/db/geojson";

export type Bounds = [number, number, number, number];

export interface FlaggedLayer {
  // Each flagged feature carries its report row's (or group's) `key`.
  geojson: string;
  bounds: Map<string, Bounds>;
}

// Writes `out(key, fid)`: the units each report row names in `codeFields`, matched
// through each level's code column.
export async function buildFlagged(
  conn: AsyncDuckDBConnection,
  out: string,
  report: string,
  attrTable: string,
  codeColumns: Array<{ level: number; column: string }>,
  codeFields: string[] = ["code_a", "code_b"],
): Promise<void> {
  const fields = codeFields.map((f) => `i.${f}`).join(", ");
  const unions = codeColumns.map(
    ({ level, column }) => `--sql
      SELECT i.key, t.fid FROM ${report} i JOIN ${attrTable} t
        ON t.${quoteIdent(column)}::VARCHAR IN (${fields})
      WHERE i.level = ${level}`,
  );
  unions.push("SELECT NULL::VARCHAR AS key, NULL::BIGINT AS fid WHERE false");
  await conn.query(
    `CREATE OR REPLACE TABLE ${out} AS SELECT DISTINCT * FROM (${unions.join(" UNION ALL ")})`,
  );
}

// The map layer and per-key bounds for `sql`, any query yielding (key, geom); other columns become feature properties.
export async function flaggedLayer(
  conn: AsyncDuckDBConnection,
  sql: string,
): Promise<FlaggedLayer> {
  const geojson = await queryToGeoJSON(
    conn,
    `SELECT ST_AsGeoJSON(geom) AS _geom, * EXCLUDE (geom) FROM (${sql}) WHERE geom IS NOT NULL`,
  );
  const rows = (
    await conn.query(`--sql
      SELECT key, MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM (${sql}) WHERE geom IS NOT NULL GROUP BY key
    `)
  ).toArray() as Array<{ key: string; xmin: number; ymin: number; xmax: number; ymax: number }>;
  return {
    geojson,
    bounds: new Map(rows.map((r) => [r.key, [r.xmin, r.ymin, r.xmax, r.ymax]])),
  };
}

// The (key, geom) query for a `buildFlagged` table over layer_01, plus each finding's severity given its report.
export const flaggedUnitsSql = (flagged: string, report?: string): string =>
  report
    ? `SELECT f.key, r.severity, g.geom FROM ${flagged} f JOIN ${report} r USING (key) JOIN layer_01 g USING (fid)`
    : `SELECT f.key, g.geom FROM ${flagged} f JOIN layer_01 g USING (fid)`;
