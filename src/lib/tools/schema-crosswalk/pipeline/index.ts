import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { runSchemaMap, type CrosswalkRow, type TargetSchema } from "$lib/tools/schema-map/pipeline/index";
import { runSchemaRefactor, type SchemaRefactorResult } from "$lib/tools/schema-refactor/pipeline/index";

export type { CrosswalkRow } from "$lib/tools/schema-map/pipeline/index";
export { DEFAULT_TARGET_SCHEMA, validateTargetSchema } from "$lib/tools/schema-map/pipeline/index";
export type { TargetSchema } from "$lib/tools/schema-map/pipeline/index";
export type { SchemaRefactorResult } from "$lib/tools/schema-refactor/pipeline/index";

export interface SchemaCrosswalkResult {
  crosswalk: CrosswalkRow[];
  refactor: SchemaRefactorResult;
}

// No table names collide between the two pipelines, so they run unmodified.
export async function runSchemaCrosswalk(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema,
): Promise<SchemaCrosswalkResult> {
  const crosswalk = await runSchemaMap(conn, schema);
  const refactor = await runSchemaRefactor(conn, crosswalk);
  return { crosswalk, refactor };
}
