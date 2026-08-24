import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { buildDissolveIssues, type DissolveIssueRow } from "./issues";

export type { DissolveIssueRow } from "./issues";

export type ProgressFn = (stage: number, label: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface DissolveResult {
  dissolvedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  keptColumns: string[];
  droppedColumns: string[];
  issues: DissolveIssueRow[];
  issuesGeoJSON: string;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ${table} WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    if ([xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))) {
      setCentroidLat((ymin + ymax) / 2);
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Max distinct count per column across groups, collapsed to one summary row
// (ported from topo-tools-py's core/dissolve/_02_dissolve.py).
async function distinctCounts(
  conn: AsyncDuckDBConnection,
  table: string,
  groupBy: string[],
  columns: string[],
): Promise<Record<string, number>> {
  if (columns.length === 0) return {};
  const groupBySql = groupBy.map((c) => `"${c}"`).join(", ");
  const countsSql = columns.map((c, i) => `COUNT(DISTINCT "${c}") AS "__auto_${i}"`).join(", ");
  const summarySql = columns.map((_, i) => `MAX("__auto_${i}") AS "c${i}"`).join(", ");
  const r = await conn.query(`--sql
    WITH counts AS (
      SELECT ${groupBySql}, ${countsSql}
      FROM ${table}
      GROUP BY ${groupBySql}
    )
    SELECT ${summarySql} FROM counts
  `);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const out: Record<string, number> = {};
  columns.forEach((c, i) => {
    out[c] = Number(row[`c${i}`]);
  });
  return out;
}

// DESCRIBE, per-column distinct-count check, then one GROUP BY + ST_Union_Agg
// query (topo-tools-py's dissolve, ported 1:1, see docs/explanation/dissolve.md).
export async function runDissolve(
  conn: AsyncDuckDBConnection,
  groupBy: string[],
  onProgress: ProgressFn,
): Promise<DissolveResult> {
  if (groupBy.length === 0) {
    throw new Error("Pick at least one column to group by.");
  }

  onProgress(1, "Dissolving");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ds_input AS
    SELECT a.fid, a.geom, b.* EXCLUDE (fid)
    FROM layer_01 a LEFT JOIN layer_attr b ON a.fid = b.fid
  `);

  const desc = await conn.query(`DESCRIBE ds_input`);
  const allCols = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
  const excluded = new Set([...groupBy, "fid", "geom"]);
  const candidateCols = allCols.filter((c) => !excluded.has(c));

  const stats = await distinctCounts(conn, "ds_input", groupBy, candidateCols);
  const keptCols = candidateCols.filter((c) => stats[c] <= 1);
  const droppedCols = candidateCols.filter((c) => stats[c] > 1);

  const groupBySql = groupBy.map((c) => `"${c}"`).join(", ");
  const keptSql = keptCols.map((c) => `, any_value("${c}") AS "${c}"`).join("");

  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ds_dissolved AS
      SELECT row_number() OVER () AS fid, ${groupBySql}${keptSql},
             ST_MakeValid(ST_Union_Agg(geom)) AS geom
      FROM ds_input
      GROUP BY ${groupBySql}
    `);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 1);
  }

  const bounds = await computeBounds(conn, "ds_dissolved");

  onProgress(2, "Checking for gaps");
  const { rows, geojson } = await buildDissolveIssues(conn, "ds_dissolved");

  // Split into geom/attr tables, same shape every other tool's output uses.
  const attrCols = [...groupBy, ...keptCols].map((c) => `"${c}"`).join(", ");
  await conn.query(`CREATE OR REPLACE TABLE ds_dissolved_geom AS SELECT fid, geom FROM ds_dissolved`);
  await conn.query(`CREATE OR REPLACE TABLE ds_dissolved_attr AS SELECT fid, ${attrCols} FROM ds_dissolved`);

  const dissolvedGeoJSON = await tableToGeoJSON(conn, "ds_dissolved_geom", "ds_dissolved_attr");

  return {
    dissolvedGeoJSON,
    bounds,
    keptColumns: keptCols,
    droppedColumns: droppedCols,
    issues: rows,
    issuesGeoJSON: geojson,
  };
}
