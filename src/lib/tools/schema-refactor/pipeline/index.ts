import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import type { CrosswalkRow } from "./crosswalk";
import { renameColumns } from "./rename";
import { actualColumns, validateColumnsMatch, validateTargets } from "./validate";

export type { CrosswalkRow } from "./crosswalk";
export { loadCrosswalkCsv, parseCrosswalk } from "./crosswalk";
export { targetIssues } from "./validate";

export interface SchemaRefactorResult {
  renamedCount: number;
  droppedColumns: string[];
  // Deepest level's code column the rows are sorted by; null keeps input order.
  sortColumn: string | null;
}

// No topology gate: renaming never touches geometry. The result is layer_01's
// geometry joined to sr_result_attr on fid (docs/reference/schema-refactor.md).
export async function runSchemaRefactor(
  conn: AsyncDuckDBConnection,
  crosswalk: CrosswalkRow[],
  schema: TargetSchema,
): Promise<SchemaRefactorResult> {
  const actual = await actualColumns(conn);
  const crosswalkColumns = new Set(crosswalk.map((r) => r.sourceColumn));
  validateColumnsMatch(crosswalkColumns, actual);
  validateTargets(crosswalk);

  const sortColumn = await renameColumns(conn, crosswalk, schema);

  const droppedColumns = crosswalk
    .filter((r) => !r.targetColumn)
    .map((r) => r.sourceColumn)
    .sort();

  return {
    renamedCount: crosswalk.length - droppedColumns.length,
    droppedColumns,
    sortColumn,
  };
}
