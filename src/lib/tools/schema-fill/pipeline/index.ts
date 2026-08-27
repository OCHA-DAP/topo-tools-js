import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import {
  DEFAULT_TARGET_SCHEMA,
  type TargetSchema,
  validateTargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { detectLevels } from "./levels";
import { runFill } from "./fill";

export {
  DEFAULT_TARGET_SCHEMA,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";

export const DEFAULT_DEPTH_COLUMN = "adm_lvl";

export interface SchemaFillResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levels: number[];
  depthColumn: string;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM layer_01 WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))
    ? [xmin, ymin, xmax, ymax]
    : null;
}

// No topology gate: fill only touches attribute columns, layer_01's
// geometry passes through into the result unchanged.
export async function runSchemaFill(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema = DEFAULT_TARGET_SCHEMA,
  depthColumn: string = DEFAULT_DEPTH_COLUMN,
): Promise<SchemaFillResult> {
  validateTargetSchema(schema);
  const levels = await detectLevels(conn, "layer_attr", schema);
  await runFill(conn, "layer_attr", "sf_result_attr", { levels, schema, depthColumn });

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "sf_result_attr");
  const bounds = await computeBounds(conn);

  return { resultGeoJSON, bounds, levels, depthColumn };
}
