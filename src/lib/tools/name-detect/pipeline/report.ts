import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import {
  PER_NAME_KINDS,
  ROLLUP_MIN_ROWS,
  ROLLUP_SHARE,
  SEVERITY,
  type NameIssueKind,
  type Severity,
} from "./constants";

export const REPORT_COLUMNS = [
  "key",
  "kind",
  "severity",
  "level",
  "name_column",
  "code_a",
  "name_a",
  "code_b",
  "name_b",
  "suggested",
  "reason",
];

export interface NameIssueRow {
  key: string;
  kind: NameIssueKind;
  severity: Severity;
  level: number;
  nameColumn: string;
  codeA: string | null;
  nameA: string | null;
  codeB: string | null;
  nameB: string | null;
  suggested: string | null;
  reason: string;
  fixed: boolean | null;
}

// Writes `${prefix}_report`: per-unit findings, a column-wide per-name kind collapsed
// into one row. fixedSql, if given, is a SQL expression over a row added as `fixed`.
export async function buildNameReport(
  conn: AsyncDuckDBConnection,
  prefix: string,
  fixedSql: string | null = null,
): Promise<NameIssueRow[]> {
  const kinds = PER_NAME_KINDS.map((k) => `'${k}'`).join(", ");
  const severity = Object.entries(SEVERITY)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(" ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${prefix}_report AS
    WITH totals AS (
      SELECT level, name_column, COUNT(*) AS total FROM ${prefix}_02 GROUP BY ALL
    ), hits AS (
      SELECT kind, level, name_column, COUNT(*) AS n, any_value(reason) AS reason
      FROM ${prefix}_03 WHERE kind IN (${kinds}) GROUP BY ALL
    ), rolled AS (
      SELECT h.* FROM hits h JOIN totals t USING (level, name_column)
      WHERE h.n >= ${ROLLUP_MIN_ROWS} AND h.n > t.total * ${ROLLUP_SHARE}
    ), findings AS (
      SELECT i.* FROM ${prefix}_03 i ANTI JOIN rolled r USING (kind, level, name_column)
      UNION ALL
      SELECT r.kind, r.level, r.name_column, NULL, NULL, NULL, NULL, NULL,
             printf('%d of %d names in this column: %s', r.n, t.total, r.reason)
      FROM rolled r JOIN totals t USING (level, name_column)
    ), merged AS (
      -- One unit blank in several language columns is one row.
      SELECT * FROM findings WHERE kind <> 'blank-name' OR code_a IS NULL
      UNION ALL
      SELECT kind, level, string_agg(name_column, ', ' ORDER BY name_column),
             code_a, NULL, NULL, NULL, NULL, any_value(reason)
      FROM findings WHERE kind = 'blank-name' AND code_a IS NOT NULL
      GROUP BY kind, level, code_a
    )
    SELECT * FROM (
      SELECT kind || '-' || row_number() OVER (
               PARTITION BY kind ORDER BY level, name_column, code_a, name_a
             ) AS key,
             kind, CASE kind ${severity} END AS severity, level, name_column,
             code_a, name_a, code_b, name_b, suggested, reason
             ${fixedSql ? `, ${fixedSql} AS fixed` : ""}
      FROM merged
    )
    ORDER BY severity, level, name_column, kind, code_a, name_a
  `);
  const rows = (await conn.query(`SELECT * FROM ${prefix}_report`)).toArray() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    key: r.key as string,
    kind: r.kind as NameIssueKind,
    severity: r.severity as Severity,
    level: Number(r.level),
    nameColumn: r.name_column as string,
    codeA: (r.code_a as string | null) ?? null,
    nameA: (r.name_a as string | null) ?? null,
    codeB: (r.code_b as string | null) ?? null,
    nameB: (r.name_b as string | null) ?? null,
    suggested: (r.suggested as string | null) ?? null,
    reason: r.reason as string,
    fixed: fixedSql ? Boolean(r.fixed) : null,
  }));
}

// Writes `${prefix}_flagged(key, fid)`: each report row's units, for the map.
export async function buildFlagged(
  conn: AsyncDuckDBConnection,
  prefix: string,
  attrTable: string,
): Promise<void> {
  const columns = (
    await conn.query(`SELECT DISTINCT level, code_column FROM ${prefix}_02`)
  ).toArray() as Array<{ level: number; code_column: string }>;
  const unions = columns.map(
    ({ level, code_column }) => `--sql
      SELECT i.key, t.fid FROM ${prefix}_report i JOIN ${attrTable} t
        ON t.${quoteIdent(code_column)}::VARCHAR IN (i.code_a, i.code_b)
      WHERE i.level = ${level}`,
  );
  unions.push("SELECT NULL::VARCHAR AS key, NULL::BIGINT AS fid WHERE false");
  await conn.query(
    `CREATE OR REPLACE TABLE ${prefix}_flagged AS SELECT DISTINCT * FROM (${unions.join(" UNION ALL ")})`,
  );
}
