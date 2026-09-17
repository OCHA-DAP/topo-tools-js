import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { lastComponent, parentPrefix, quoteIdent, type CodeFormat } from "$lib/db/code";

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

export interface CodeIssueRow {
  kind: string;
  level: number;
  parentCode: string;
  assignedCode: string;
  childCount: number;
  minWidth: number;
  reason: string;
}

// Groups each level's distinct codes by parent, flags any group whose count
// exceeds minWidth's digit capacity. Always (re)writes cr_issues, even empty.
export async function buildCodeIssues(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, string>,
  fmt: CodeFormat,
): Promise<CodeIssueRow[]> {
  const capacity = 10 ** fmt.minWidth - 1;
  const rows: CodeIssueRow[] = [];

  for (const [level, codeColumn] of levels) {
    const qCode = quoteIdent(codeColumn);
    const codes = (
      (await conn.query(`SELECT DISTINCT ${qCode} AS v FROM ${quoteIdent(table)}`)).toArray() as Array<{
        v: string;
      }>
    ).map((r) => r.v);

    const byParent = new Map<string, string[]>();
    for (const code of codes) {
      const parent = parentPrefix(code, fmt);
      const group = byParent.get(parent);
      if (group) group.push(code);
      else byParent.set(parent, [code]);
    }

    for (const [parentCode, children] of byParent) {
      if (children.length <= capacity) continue;
      const assignedCode = children.reduce((best, c) =>
        Number(lastComponent(c, fmt)) > Number(lastComponent(best, fmt)) ? c : best,
      );
      rows.push({
        kind: "digit-overflow",
        level,
        parentCode,
        assignedCode,
        childCount: children.length,
        minWidth: fmt.minWidth,
        reason: `${children.length} children exceeds ${capacity} at min_width=${fmt.minWidth}`,
      });
    }
  }

  await writeIssuesTable(conn, rows);
  return rows;
}

async function writeIssuesTable(conn: AsyncDuckDBConnection, rows: CodeIssueRow[]): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cr_issues");
  await conn.query(`--sql
    CREATE TABLE cr_issues (
      kind VARCHAR, level INTEGER, parent_code VARCHAR, assigned_code VARCHAR,
      child_count INTEGER, min_width INTEGER, reason VARCHAR
    )
  `);
  if (rows.length === 0) return;

  const values = rows
    .map(
      (r) =>
        `(${sqlStr(r.kind)}, ${r.level}, ${sqlStr(r.parentCode)}, ${sqlStr(r.assignedCode)}, ${r.childCount}, ${r.minWidth}, ${sqlStr(r.reason)})`,
    )
    .join(", ");
  await conn.query(`INSERT INTO cr_issues VALUES ${values}`);
}
