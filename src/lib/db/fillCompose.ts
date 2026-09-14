import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { resolveLevels, runFill } from "$lib/tools/schema-fill/pipeline/fill";

export interface FillFlags {
  fillSchema: boolean;
  nameField: string | null;
  codeField: string | null;
}

export function validateFillFlags({ fillSchema, nameField, codeField }: FillFlags): void {
  if ((nameField === null) !== (codeField === null)) {
    throw new Error("nameField and codeField must both be set, or both left unset.");
  }
  if (!fillSchema && (nameField !== null || codeField !== null)) {
    throw new Error("nameField/codeField require fillSchema to be enabled.");
  }
}

export interface ApplyFillOptions {
  requested: boolean;
  nameField: string | null;
  codeField: string | null;
  depthColumn: string;
}

// Opt-in cascade of an already-produced tool's own final attribute table,
// reusing schema-fill's depth-pin core in place; a no-op when not requested.
export async function applyOptionalFill(
  conn: AsyncDuckDBConnection,
  attrTable: string,
  { requested, nameField, codeField, depthColumn }: ApplyFillOptions,
): Promise<void> {
  validateFillFlags({ fillSchema: requested, nameField, codeField });
  if (!requested) return;

  const schema: TargetSchema | null =
    nameField !== null && codeField !== null ? { nameField, codeField } : null;
  const levels = await resolveLevels(conn, attrTable, schema);

  const scratch = `${attrTable}_fillscratch`;
  await runFill(conn, attrTable, scratch, { levels, schema, depthColumn });
  await conn.query(`CREATE OR REPLACE TABLE "${attrTable}" AS SELECT * FROM "${scratch}"`);
  await conn.query(`DROP TABLE IF EXISTS "${scratch}"`);
}
