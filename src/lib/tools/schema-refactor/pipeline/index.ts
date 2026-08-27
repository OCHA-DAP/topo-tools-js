import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import type { CrosswalkRow } from "./crosswalk";
import { renameColumns } from "./rename";
import { actualColumns, validateColumnsMatch, validateTargets } from "./validate";

export type { CrosswalkRow } from "./crosswalk";
export { loadCrosswalkCsv, parseCrosswalk } from "./crosswalk";

export interface SchemaRefactorResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  renamedCount: number;
  droppedColumns: string[];
}

async function computeBounds(conn: AsyncDuckDBConnection): Promise<[number, number, number, number] | null> {
  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM layer_01 WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v)) ? [xmin, ymin, xmax, ymax] : null;
}

// No topology gate: renaming never touches geometry, layer_01 passes through
// into the result unchanged (docs/reference/schema-refactor.md).
export async function runSchemaRefactor(
  conn: AsyncDuckDBConnection,
  crosswalk: CrosswalkRow[],
): Promise<SchemaRefactorResult> {
  const actual = await actualColumns(conn);
  const crosswalkColumns = new Set(crosswalk.map((r) => r.sourceColumn));
  validateColumnsMatch(crosswalkColumns, actual);
  validateTargets(crosswalk);

  await renameColumns(conn, crosswalk);

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "sr_result_attr");
  const bounds = await computeBounds(conn);
  const droppedColumns = crosswalk
    .filter((r) => !r.targetColumn)
    .map((r) => r.sourceColumn)
    .sort();

  return {
    resultGeoJSON,
    bounds,
    renamedCount: crosswalk.length - droppedColumns.length,
    droppedColumns,
  };
}
