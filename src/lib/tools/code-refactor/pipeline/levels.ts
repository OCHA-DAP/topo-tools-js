import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  detectLevelColumnsOrSingle,
  verifyFunctionalCluster,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

// A constant coarsest column (empty groupBy) is dropped before renumbering,
// so every resolved level ends up a clean 1..N regardless of raw level number.
export async function resolveCodeLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
): Promise<Map<number, string>> {
  if (schema !== null) {
    const levels = await detectLevels(conn, table, schema);
    const result = new Map<number, string>();
    for (const n of levels) result.set(n, schema.codeField.replace("{n}", String(n)));
    return result;
  }

  const levelColumns = await detectLevelColumnsOrSingle(conn, table);
  const coded = [...levelColumns.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, cols]) => cols.groupBy.length > 0);
  if (coded.length === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }
  const missing = coded.filter(([, cols]) => !cols.hasCode).map(([n]) => n);
  if (missing.length > 0) {
    throw new Error(
      `no existing code column to overwrite for level(s) ${missing.join(", ")} in ${table}; set the name/code field template explicitly`,
    );
  }

  const result = new Map<number, string>();
  for (const [, cols] of coded) {
    const canonical = cols.groupBy[0];
    await verifyFunctionalCluster(conn, table, canonical, cols.groupBy);
    result.set(result.size + 1, canonical);
  }
  return result;
}
