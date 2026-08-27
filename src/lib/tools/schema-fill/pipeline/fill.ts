import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { escapeRegExp, fieldPrefix, levelPrefix } from "./levels";

// Groups level columns by suffix, e.g. {"_code": {1: "adm1_code", ...}}.
function columnFamilies(
  columns: string[],
  levels: number[],
  prefix: string,
): Map<string, Map<number, string>> {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)(.*)$`);
  const families = new Map<string, Map<number, string>>();
  for (const column of columns) {
    const m = pattern.exec(column);
    if (!m) continue;
    const level = Number(m[1]);
    if (!levels.includes(level)) continue;
    if (!families.has(m[2])) families.set(m[2], new Map());
    families.get(m[2])!.set(level, column);
  }
  return families;
}

function depthColumnSql(codeColumns: Map<number, string>, depthColumn: string): string {
  const cases = [...codeColumns.keys()]
    .sort((a, b) => b - a)
    .map((lvl) => `WHEN ${JSON.stringify(codeColumns.get(lvl))} IS NOT NULL THEN ${lvl}`)
    .join(" ");
  return `CASE ${cases} END AS ${JSON.stringify(depthColumn)}`;
}

export interface FillOptions {
  levels: number[];
  schema: TargetSchema;
  depthColumn: string;
}

// depthColumn is stamped from tableIn's raw columns: DuckDB resolves a
// later same-named expression against the FROM clause, not a sibling alias.
export async function runFill(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  { levels, schema, depthColumn }: FillOptions,
): Promise<void> {
  const codePrefix = levelPrefix(schema);
  const namePrefix = fieldPrefix(schema.nameField);
  const codeSuffix = schema.codeField.split("{n}")[1];

  const desc = await conn.query(`DESCRIBE "${tableIn}"`);
  const columns = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);

  const filledColumns = new Set<string>();
  const filledSelectParts: string[] = [];
  let codeColumns = new Map<number, string>();

  for (const prefix of new Set([codePrefix, namePrefix])) {
    const families = columnFamilies(columns, levels, prefix);
    if (prefix === codePrefix) codeColumns = families.get(codeSuffix) ?? new Map();

    for (const perLevel of families.values()) {
      for (const col of perLevel.values()) filledColumns.add(col);
      const sortedLevels = [...perLevel.keys()].sort((a, b) => a - b);
      for (const level of sortedLevels) {
        const chain = sortedLevels.filter((k) => k <= level).map((k) => perLevel.get(k)!);
        const target = JSON.stringify(perLevel.get(level)!);
        if (chain.length > 1) {
          const coalesce = [...chain]
            .reverse()
            .map((c) => JSON.stringify(c))
            .join(", ");
          filledSelectParts.push(`COALESCE(${coalesce}) AS ${target}`);
        } else {
          filledSelectParts.push(target);
        }
      }
    }
  }

  const selectParts = columns
    .filter((c) => !filledColumns.has(c))
    .map((c) => JSON.stringify(c))
    .concat(filledSelectParts);
  selectParts.push(depthColumnSql(codeColumns, depthColumn));

  await conn.query(
    `CREATE OR REPLACE TABLE "${tableOut}" AS SELECT ${selectParts.join(", ")} FROM "${tableIn}"`,
  );
}
