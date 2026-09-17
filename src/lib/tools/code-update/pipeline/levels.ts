import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { detectCodeFormat, resolveCodeFormat, type CodeFormat } from "$lib/db/code";
import {
  detectLevelColumnsOrSingle,
  verifyFunctionalCluster,
  type LevelColumns,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

// One side's (OLD or NEW) resolved per-level code/name columns, renumbered 1..N.
export interface SideLevels {
  columns: Map<number, string>;
  names: Map<number, string | null>;
  schema: TargetSchema | null;
  levelColumns: Map<number, LevelColumns> | null;
}

async function resolveSide(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
): Promise<SideLevels> {
  if (schema !== null) {
    const levels = await detectLevels(conn, table, schema);
    const columns = new Map<number, string>();
    const names = new Map<number, string | null>();
    for (const n of levels) {
      columns.set(n, schema.codeField.replace("{n}", String(n)));
      names.set(n, schema.nameField.replace("{n}", String(n)));
    }
    return { columns, names, schema, levelColumns: null };
  }

  const raw = await detectLevelColumnsOrSingle(conn, table);
  const coded = [...raw.entries()].sort((a, b) => a[0] - b[0]).filter(([, cols]) => cols.groupBy.length > 0);
  if (coded.length === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }
  const missing = coded.filter(([, cols]) => !cols.hasCode).map(([n]) => n);
  if (missing.length > 0) {
    throw new Error(
      `no existing code column to overwrite for level(s) ${missing.join(", ")} in ${table}; set the name/code field template explicitly`,
    );
  }

  const columns = new Map<number, string>();
  const names = new Map<number, string | null>();
  const levelColumns = new Map<number, LevelColumns>();
  let n = 1;
  for (const [, cols] of coded) {
    const canonical = cols.groupBy[0];
    await verifyFunctionalCluster(conn, table, canonical, cols.groupBy);
    columns.set(n, canonical);
    names.set(n, cols.nameColumn);
    levelColumns.set(n, cols);
    n++;
  }
  return { columns, names, schema: null, levelColumns };
}

export interface ResolvedSideLevels {
  sideA: SideLevels;
  sideB: SideLevels;
  fmt: CodeFormat;
}

// Resolves OLD/NEW per-level columns; detects (or accepts an override for) fmt.
export async function resolveSideLevels(
  conn: AsyncDuckDBConnection,
  oldTable: string,
  newTable: string,
  schemaA: TargetSchema | null,
  schemaB: TargetSchema | null,
  rootCode: string | null,
  delimiter: string | null,
  minWidth: number | null,
): Promise<ResolvedSideLevels> {
  const sideA = await resolveSide(conn, oldTable, schemaA);
  const sideB = await resolveSide(conn, newTable, schemaB);

  const levelsA = [...sideA.columns.keys()].sort((a, b) => a - b);
  const levelsB = [...sideB.columns.keys()].sort((a, b) => a - b);
  if (levelsA.join(",") !== levelsB.join(",")) {
    throw new Error(
      `level mismatch between old (${levelsA.join(", ")}) and new (${levelsB.join(", ")}); a real level-count change needs a human decision, not an automatic pass`,
    );
  }

  let fmt: CodeFormat;
  if (rootCode === null || delimiter === null || minWidth === null) {
    const finest = Math.max(...sideA.columns.keys());
    const detected = await detectCodeFormat(conn, oldTable, sideA.columns.get(finest)!);
    fmt = resolveCodeFormat(
      rootCode ?? detected.rootCode,
      delimiter ?? detected.delimiter,
      minWidth ?? detected.minWidth,
    );
  } else {
    fmt = resolveCodeFormat(rootCode, delimiter, minWidth);
  }
  return { sideA, sideB, fmt };
}
