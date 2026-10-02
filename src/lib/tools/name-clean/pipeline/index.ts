import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import { FIXED_KINDS } from "$lib/tools/name-detect/pipeline/constants";
import {
  nameResult,
  scanNames,
  type NameResult,
  type TargetSchema,
} from "$lib/tools/name-detect/pipeline";

export type { NameIssueRow, TargetSchema } from "$lib/tools/name-detect/pipeline";

const KINDS = FIXED_KINDS.map((k) => `'${k}'`).join(", ");

// True for a report row whose finding was fixed. A column row (no code) of an
// encoding kind may hold units with no repair.
const FIXED_SQL =
  `kind IN (${KINDS}) AND (suggested IS NOT NULL ` +
  "OR (code_a IS NULL AND kind <> 'encoding-artifact'))";

// Rewrites each flagged unit's name as name_clean(name) in attrTable, blanks untouched.
async function applyFixes(conn: AsyncDuckDBConnection, prefix: string, attrTable: string) {
  const targets = (
    await conn.query(`--sql
      SELECT DISTINCT f.name_column, l.code_column
      FROM ${prefix}_03 f
      JOIN (SELECT DISTINCT level, name_column, code_column FROM ${prefix}_02) l
        USING (level, name_column)
      WHERE f.kind IN (${KINDS}) AND f.suggested IS NOT NULL
    `)
  ).toArray() as Array<{ name_column: string; code_column: string }>;
  for (const { name_column, code_column } of targets) {
    const col = quoteIdent(name_column);
    await conn.query(`--sql
      UPDATE ${attrTable} SET ${col} = name_clean(${col})
      WHERE ${quoteIdent(code_column)}::VARCHAR IN (
        SELECT code_a FROM ${prefix}_03
        WHERE kind IN (${KINDS}) AND suggested IS NOT NULL
          AND name_column = '${name_column.replace(/'/g, "''")}'
      )
        AND name_clean(${col}) <> ''
    `);
  }
}

// Fixes are written into nc_attr, a fresh copy of layer_attr per run.
export async function runNameClean(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<NameResult> {
  await conn.query("CREATE OR REPLACE TABLE nc_attr AS SELECT * FROM layer_attr");
  const scan = await scanNames(conn, "nc_attr", "nc", schema);
  await applyFixes(conn, "nc", "nc_attr");
  return nameResult(conn, "nc", "nc_attr", scan, FIXED_SQL);
}
