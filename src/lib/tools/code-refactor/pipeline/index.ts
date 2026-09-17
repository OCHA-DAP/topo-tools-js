import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { resolveCodeFormat, type CodeFormat } from "$lib/db/code";
import { tableToGeoJSON } from "$lib/db/geojson";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { assignRefactorCodes } from "./assign";
import { buildCodeIssues, type CodeIssueRow } from "./issues";
import { resolveCodeLevels } from "./levels";

export { resolveCodeFormat } from "$lib/db/code";
export type { CodeFormat } from "$lib/db/code";
export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { CodeIssueRow } from "./issues";

export interface CodeRefactorResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levelCount: number;
  issues: CodeIssueRow[];
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

// Codes are overwritten in place on layer_attr (values only, no rename), so
// unlike schema-refactor this needs no separate *_result_attr copy.
export async function runCodeRefactor(
  conn: AsyncDuckDBConnection,
  rootCode: string,
  delimiter: string,
  minWidth: number,
  schema: TargetSchema | null,
): Promise<CodeRefactorResult> {
  const fmt: CodeFormat = resolveCodeFormat(rootCode, delimiter, minWidth);
  const levels = await resolveCodeLevels(conn, "layer_attr", schema);
  await assignRefactorCodes(conn, "layer_attr", levels, fmt);
  const issues = await buildCodeIssues(conn, "layer_attr", levels, fmt);

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "layer_attr");
  const bounds = await computeBounds(conn);
  return { resultGeoJSON, bounds, levelCount: levels.size, issues };
}
