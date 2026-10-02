import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { columnFamilies, escapeRegExp, fieldPrefix } from "$lib/db/adminColumns";

export { columnFamilies, escapeRegExp, fieldPrefix };

export function levelPrefix(schema: TargetSchema): string {
  return fieldPrefix(schema.codeField);
}

// Level 1..N (N = deepest found), plus 0 when its code column exists; raises on a level
// missing its code (or both code and name when !requireCodes) or no match at all.
export async function detectLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema,
  { requireCodes = true }: { requireCodes?: boolean } = {},
): Promise<number[]> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  const columns = new Set(
    (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name),
  );

  const prefix = levelPrefix(schema);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)`);
  const found = new Set<number>();
  for (const c of columns) {
    const m = pattern.exec(c);
    if (m) found.add(Number(m[1]));
  }
  const levels = [...found].filter((n) => n >= 1).sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new Error(`no "${prefix}"-prefixed level column found in ${table}`);
  }

  const maxLevel = levels[levels.length - 1];
  const missing: number[] = [];
  for (let n = 1; n <= maxLevel; n++) {
    if (
      !columns.has(schema.codeField.replace("{n}", String(n))) &&
      (requireCodes || !columns.has(schema.nameField.replace("{n}", String(n))))
    )
      missing.push(n);
  }
  if (missing.length > 0) {
    const cols = missing.map((n) => schema.codeField.replace("{n}", String(n)));
    throw new Error(
      `missing code column(s) for level(s) ${missing.join(", ")}: ${cols.join(", ")}`,
    );
  }

  const result = Array.from({ length: maxLevel }, (_, i) => i + 1);
  if (columns.has(schema.codeField.replace("{n}", "0"))) result.unshift(0);
  return result;
}
