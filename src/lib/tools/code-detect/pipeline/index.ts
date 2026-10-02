import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildFlagged, flaggedLayer, flaggedUnitsSql, type FlaggedLayer } from "$lib/db/flagged";
import { buildLevelUnits, resolveLevels } from "$lib/tools/schema-map/pipeline/resolveLevels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { runCodeChecks } from "./checks";
import { SEVERITY, type CodeIssueKind, type Severity } from "./constants";

export type { CodeIssueKind, Severity } from "./constants";

export const REPORT_COLUMNS = [
  "key",
  "kind",
  "severity",
  "level",
  "column",
  "code_a",
  "name_a",
  "code_b",
  "name_b",
  "reason",
];

export interface CodeIssueRow {
  key: string;
  kind: CodeIssueKind;
  severity: Severity;
  level: number;
  column: string;
  codeA: string | null;
  nameA: string | null;
  codeB: string | null;
  nameB: string | null;
  reason: string;
}

export interface CodeResult {
  issues: CodeIssueRow[];
  failed: CodeIssueKind[];
  map: FlaggedLayer;
}

// Writes `${prefix}_report` over layer_attr's units, one row per finding.
export async function runCodeDetect(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  prefix = "cd",
): Promise<CodeResult> {
  const levels = await resolveLevels(conn, "layer_attr", schema);
  await buildLevelUnits(conn, "layer_attr", prefix, levels, { nameless: true });
  const failed = await runCodeChecks(conn, prefix);
  const severity = Object.entries(SEVERITY)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(" ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${prefix}_report AS
    SELECT kind || '-' || row_number() OVER (
             PARTITION BY kind ORDER BY level, column_name, code_a, name_a
           ) AS key,
           kind, CASE kind ${severity} END AS severity, level,
           column_name AS "column", code_a, name_a, code_b, name_b, reason
    FROM ${prefix}_03
    ORDER BY severity, level, kind, "column", code_a, name_a
  `);
  const rows = (await conn.query(`SELECT * FROM ${prefix}_report`)).toArray() as Array<
    Record<string, unknown>
  >;
  const codeColumns = [...levels.entries()].map(([level, l]) => ({ level, column: l.code }));
  // code_b is the parent code for prefix-mismatch, so only code_a names the unit.
  await buildFlagged(conn, `${prefix}_flagged`, `${prefix}_report`, "layer_attr", codeColumns, [
    "code_a",
  ]);
  return {
    issues: rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as CodeIssueKind,
      severity: r.severity as Severity,
      level: Number(r.level),
      column: r.column as string,
      codeA: (r.code_a as string | null) ?? null,
      nameA: (r.name_a as string | null) ?? null,
      codeB: (r.code_b as string | null) ?? null,
      nameB: (r.name_b as string | null) ?? null,
      reason: r.reason as string,
    })),
    failed,
    map: await flaggedLayer(conn, flaggedUnitsSql(`${prefix}_flagged`)),
  };
}
