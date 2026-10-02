import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildFlagged, flaggedLayer, flaggedUnitsSql, type FlaggedLayer } from "$lib/db/flagged";
import {
  buildLevelUnits,
  resolveLevels,
  type Level,
} from "$lib/tools/schema-map/pipeline/resolveLevels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { runNameChecks } from "./checks";
import type { NameIssueKind } from "./constants";
import { buildNameReport, type NameIssueRow } from "./report";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { NameIssueKind, Severity } from "./constants";
export { SEVERITY } from "./constants";
export type { NameIssueRow } from "./report";

export interface NameResult {
  issues: NameIssueRow[];
  failed: NameIssueKind[];
  map: FlaggedLayer;
}

// Resolves levels over attrTable and runs every check into `${prefix}_02`/`_03`.
export async function scanNames(
  conn: AsyncDuckDBConnection,
  attrTable: string,
  prefix: string,
  schema: TargetSchema | null,
): Promise<{ levels: Map<number, Level>; failed: NameIssueKind[] }> {
  const levels = await resolveLevels(conn, attrTable, schema);
  await buildLevelUnits(conn, attrTable, prefix, levels);
  const failed = await runNameChecks(conn, prefix);
  return { levels, failed };
}

// Builds `${prefix}_report` and the map highlights from a finished scan.
export async function nameResult(
  conn: AsyncDuckDBConnection,
  prefix: string,
  attrTable: string,
  scan: { levels: Map<number, Level>; failed: NameIssueKind[] },
  fixedSql: string | null,
): Promise<NameResult> {
  const issues = await buildNameReport(conn, prefix, fixedSql);
  const codeColumns = [...scan.levels.entries()].map(([level, l]) => ({ level, column: l.code }));
  await buildFlagged(conn, `${prefix}_flagged`, `${prefix}_report`, attrTable, codeColumns);
  return {
    issues,
    failed: scan.failed,
    map: await flaggedLayer(conn, flaggedUnitsSql(`${prefix}_flagged`)),
  };
}

export async function runNameDetect(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<NameResult> {
  const scan = await scanNames(conn, "layer_attr", "nd", schema);
  return nameResult(conn, "nd", "layer_attr", scan, null);
}
