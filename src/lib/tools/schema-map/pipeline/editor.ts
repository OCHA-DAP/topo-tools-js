import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { runSchemaMap, type CrosswalkRow, type TargetSchema } from "./index";
import { writeCrosswalkTable } from "./outputs";
import {
  loadCrosswalkCsv,
  parseCrosswalk,
  runSchemaRefactor,
  type SchemaRefactorResult,
} from "$lib/tools/schema-refactor/pipeline/index";
import {
  actualColumns,
  targetIssues,
  validateColumnsMatch,
} from "$lib/tools/schema-refactor/pipeline/validate";

export type { CrosswalkRow, TargetSchema } from "./index";
export { DEFAULT_TARGET_SCHEMA } from "./index";
export type { SchemaRefactorResult } from "$lib/tools/schema-refactor/pipeline/index";

// A crosswalk row as shown for editing: `targetColumn` is the effective target (null
// when unchecked), `input` the text box value, `baseTarget` what Reset returns to.
export interface EditableRow extends CrosswalkRow {
  keep: boolean;
  input: string;
  baseTarget: string | null;
  edited: boolean;
}

// Schema Refactor's target rules per row, plus a kept column with no target name.
export function rowIssues(rows: EditableRow[]): Map<string, string> {
  const issues = targetIssues(rows);
  for (const r of rows)
    if (r.keep && !r.targetColumn) issues.set(r.sourceColumn, "Target is empty");
  return issues;
}

// Schema Map's inference; also writes sm_crosswalk, which applyCrosswalk overwrites with edits.
export async function inferCrosswalk(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema,
): Promise<CrosswalkRow[]> {
  return runSchemaMap(conn, schema);
}

// Schema Refactor's rename/drop plus the crosswalk table the CSV download reads.
export async function applyCrosswalk(
  conn: AsyncDuckDBConnection,
  rows: CrosswalkRow[],
  schema: TargetSchema,
): Promise<SchemaRefactorResult> {
  const result = await runSchemaRefactor(conn, rows, schema);
  await writeCrosswalkTable(conn, rows);
  return result;
}

// Target per source column from a saved crosswalk CSV (null = drop).
export async function loadSavedCrosswalk(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  files: File[],
): Promise<Map<string, string | null>> {
  await loadCrosswalkCsv(db, conn, files);
  const rows = await parseCrosswalk(conn);
  return new Map(rows.map((r) => [r.sourceColumn, r.targetColumn]));
}

// Throws Schema Refactor's mismatch error when a saved crosswalk doesn't list exactly the layer's columns.
export function checkSavedCrosswalk(saved: Map<string, string | null>, sources: string[]): void {
  validateColumnsMatch(new Set(saved.keys()), new Set(sources));
}

// Up to `n` sorted distinct non-null values per layer column, as strings.
export async function sampleValues(
  conn: AsyncDuckDBConnection,
  n = 3,
): Promise<Record<string, string[]>> {
  const columns = [...(await actualColumns(conn))];
  if (columns.length === 0) return {};
  const select = columns
    .map(
      (c, i) =>
        `list_sort(list_distinct(list(CAST(${JSON.stringify(c)} AS VARCHAR))))[1:${n}] AS c${i}`,
    )
    .join(", ");
  const row = (await conn.query(`SELECT ${select} FROM layer_attr`)).toArray()[0]?.toJSON() ?? {};
  return Object.fromEntries(
    columns.map((c, i) => [c, Array.from((row[`c${i}`] as ArrayLike<string> | null) ?? [])]),
  );
}
