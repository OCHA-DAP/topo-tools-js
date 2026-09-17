import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignNewCodes, quoteIdent, type CodeFormat } from "$lib/db/code";

// Chains ascending: level 1 ranks under rootCode, each next level ranks
// under the prior level's just-assigned code. Write-back matches on parent too.
export async function assignRefactorCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, string>,
  fmt: CodeFormat,
): Promise<void> {
  const qTable = quoteIdent(table);
  let parentSql = `'${fmt.rootCode.replace(/'/g, "''")}'`;
  let parentColumn: string | null = null;

  for (const n of [...levels.keys()].sort((a, b) => a - b)) {
    const codeColumn = levels.get(n)!;
    const qCode = quoteIdent(codeColumn);
    const staging = quoteIdent(`${table}_code_lvl${n}`);

    await conn.query(`--sql
      CREATE OR REPLACE TEMP TABLE ${staging} AS
      SELECT ROW_NUMBER() OVER () AS row_id, orig_code, orig_code AS code_val, parent_code
      FROM (SELECT DISTINCT ${qCode} AS orig_code, ${parentSql} AS parent_code FROM ${qTable}) d
    `);
    await assignNewCodes(conn, `${table}_code_lvl${n}`, {
      idColumn: "row_id",
      parentColumn: "parent_code",
      sortColumns: ["code_val"],
      codeColumn: "code_val",
      fmt,
    });

    const parentMatch =
      parentColumn === null ? "TRUE" : `t.${quoteIdent(parentColumn)} IS NOT DISTINCT FROM s.parent_code`;
    await conn.query(`--sql
      UPDATE ${qTable} t
      SET ${qCode} = s.code_val
      FROM ${staging} s
      WHERE t.${qCode} IS NOT DISTINCT FROM s.orig_code AND ${parentMatch}
    `);
    await conn.query(`DROP TABLE IF EXISTS ${staging}`);

    parentSql = qCode;
    parentColumn = codeColumn;
  }
}
