import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { siblingName } from "$lib/db/adminColumns";
import { quoteIdent } from "$lib/db/code";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import { detectLevelColumnsOrSingle, supplementalColumns } from "./levelColumns";
import type { TargetSchema } from "./targetSchema";

// One level's code column and its name columns, primary first (may be none).
export interface Level {
  code: string;
  names: string[];
}

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

function withSiblings(name: string, columns: Set<string>): string[] {
  const found = [name];
  for (let i = 1; columns.has(siblingName(name, i)); i++) found.push(siblingName(name, i));
  return found;
}

// Every coded level, names or not; the resolution code-detect and name-detect share.
export async function resolveLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
): Promise<Map<number, Level>> {
  const columns = new Set(
    (
      (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{
        column_name: string;
      }>
    ).map((r) => r.column_name),
  );
  const result = new Map<number, Level>();
  if (schema !== null) {
    for (const n of await detectLevels(conn, table, schema, { requireCodes: false })) {
      const code = schema.codeField.replace("{n}", String(n));
      const name = schema.nameField.replace("{n}", String(n));
      // Level 0 is only a parent (one file may hold several countries).
      const names = n > 0 && columns.has(name) ? withSiblings(name, columns) : [];
      if (!columns.has(code)) {
        if (names.length > 0) {
          throw new Error(`level ${n} has names (${name}) but no code column ${code}`);
        }
        continue;
      }
      result.set(n, { code, names });
    }
  } else {
    const detected = await detectLevelColumnsOrSingle(conn, table);
    const coded = [...detected.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, cols]) => cols.groupBy.length > 0);
    // A skipped level would compare names under the wrong parent, so never guess.
    const found = coded.map(([n]) => n);
    const skipped = found.length === 0 || found.some((n, i) => n !== found[0] + i);
    if (skipped || (await supplementalColumns(conn, table)).length > 0) {
      throw new Error(
        `admin levels could not be detected reliably; set the name/code field templates explicitly`,
      );
    }
    coded.forEach(([, cols], i) => {
      const name =
        cols.nameColumn !== null && cols.identityColumns.includes(cols.nameColumn)
          ? cols.nameColumn
          : null;
      result.set(i + 1, { code: cols.groupBy[0], names: name ? withSiblings(name, columns) : [] });
    });
  }
  if (![...result.values()].some((l) => l.names.length > 0)) {
    throw new Error("no admin level with both a code and a name column found");
  }
  return result;
}

// Writes `${prefix}_02`: one row per level, name column, unit code and name. With
// `nameless`, a level without names still lists its codes under a NULL name column.
export async function buildLevelUnits(
  conn: AsyncDuckDBConnection,
  table: string,
  prefix: string,
  levels: Map<number, Level>,
  { nameless = false }: { nameless?: boolean } = {},
): Promise<void> {
  const selects: string[] = [];
  for (const [n, level] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    const parent = levels.get(n - 1);
    const parentSql = parent ? `${quoteIdent(parent.code)}::VARCHAR` : "NULL::VARCHAR";
    const columns: Array<string | null> =
      level.names.length === 0 && nameless ? [null] : level.names;
    columns.forEach((column, index) => {
      selects.push(`--sql
        SELECT ${n} AS level, ${column ? sqlStr(column) : "NULL::VARCHAR"} AS name_column,
               ${index} AS name_index, ${sqlStr(level.code)} AS code_column,
               ${quoteIdent(level.code)}::VARCHAR AS code,
               ${parentSql} AS parent_code,
               ${column ? `${quoteIdent(column)}::VARCHAR` : "NULL::VARCHAR"} AS name,
               COUNT(*) AS row_count
        FROM ${quoteIdent(table)}
        GROUP BY ALL
      `);
    });
  }
  await conn.query(`CREATE OR REPLACE TABLE ${prefix}_02 AS ${selects.join(" UNION ALL ")}`);
}
