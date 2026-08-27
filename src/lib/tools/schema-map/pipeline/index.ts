import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { inferSchemaMap, type CrosswalkRow } from "./inference";
import { writeCrosswalkTable } from "./outputs";
import { validateTargetSchema, type TargetSchema } from "./targetSchema";

export type { CrosswalkRow } from "./inference";
export { DEFAULT_TARGET_SCHEMA, validateTargetSchema } from "./targetSchema";
export type { TargetSchema } from "./targetSchema";

export async function runSchemaMap(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema,
): Promise<CrosswalkRow[]> {
  validateTargetSchema(schema);
  const rows = await inferSchemaMap(conn, "layer_attr", schema);
  await writeCrosswalkTable(conn, rows);
  return rows;
}
