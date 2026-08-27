import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fieldPrefix(template: string): string {
  return template.split("{n}")[0];
}

export function levelPrefix(schema: TargetSchema): string {
  return fieldPrefix(schema.codeField);
}

// Returns level 1..N present (N = deepest level column found), plus level 0
// when its own code column exists; raises on a gap in 1..N or no match at all.
export async function detectLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema,
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
    throw new Error(`schema-fill: no "${prefix}"-prefixed level column found in ${table}`);
  }

  const maxLevel = levels[levels.length - 1];
  const missing: number[] = [];
  for (let n = 1; n <= maxLevel; n++) {
    if (!columns.has(schema.codeField.replace("{n}", String(n)))) missing.push(n);
  }
  if (missing.length > 0) {
    const cols = missing.map((n) => schema.codeField.replace("{n}", String(n)));
    throw new Error(
      `schema-fill: missing code column(s) for level(s) ${missing.join(", ")}: ${cols.join(", ")}`,
    );
  }

  const result = Array.from({ length: maxLevel }, (_, i) => i + 1);
  if (columns.has(schema.codeField.replace("{n}", "0"))) result.unshift(0);
  return result;
}
