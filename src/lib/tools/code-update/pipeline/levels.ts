import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  checkLevelCount,
  checkUniqueNames,
  detectCodeFormat,
  detectUndelimitedFormat,
  hasDelimiter,
  parseMinWidth,
  quoteIdent,
  seedCodeFromNames,
  type CodeFormat,
} from "$lib/db/code";
import {
  detectLevelColumnsOrSingle,
  levelLikeColumns,
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

async function columnSet(conn: AsyncDuckDBConnection, table: string): Promise<Set<string>> {
  return new Set(
    (
      (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{
        column_name: string;
      }>
    ).map((r) => r.column_name),
  );
}

async function resolveSide(
  conn: AsyncDuckDBConnection,
  table: string,
  geomTable: string,
  schema: TargetSchema | null,
  seedMissingCodes = false,
): Promise<SideLevels> {
  if (schema !== null) {
    // Level 0 is the root itself, never recoded.
    const levels = (
      await detectLevels(conn, table, schema, { requireCodes: !seedMissingCodes })
    ).filter((n) => n >= 1);
    const columns = new Map<number, string>();
    const names = new Map<number, string | null>();
    for (const n of levels) {
      columns.set(n, schema.codeField.replace("{n}", String(n)));
      names.set(n, schema.nameField.replace("{n}", String(n)));
    }
    const present = await columnSet(conn, table);
    const finest = Math.max(...levels);
    for (const n of levels) {
      const code = columns.get(n)!;
      if (present.has(code)) continue;
      const name = names.get(n)!;
      await seedCodeFromNames(conn, table, n, code, present.has(name) ? name : null);
      if (columns.has(n - 1)) {
        // Same-named units under different parents must stay apart.
        await conn.query(
          `UPDATE ${quoteIdent(table)} SET ${quoteIdent(code)} = ${quoteIdent(columns.get(n - 1)!)}::VARCHAR || ' > ' || ${quoteIdent(code)}`,
        );
      }
      if (n === finest) await checkUniqueNames(conn, table, n, code);
    }
    return { columns, names, schema, levelColumns: null };
  }

  const raw = await detectLevelColumnsOrSingle(conn, table);
  const coded = [...raw.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, cols]) => cols.groupBy.length > 0);
  if (coded.length === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }
  // A skipped level would corrupt every code below it, so never guess.
  const supplemental = await levelLikeColumns(conn, table, geomTable);
  if (supplemental.length > 0) {
    throw new Error(
      `${table}: ${JSON.stringify(supplemental)} group units like a level but were not detected as one; set OLD's or NEW's name/code field template explicitly`,
    );
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
  let parent: string | null = null;
  for (const [, cols] of coded) {
    const canonical = cols.groupBy[0];
    await verifyFunctionalCluster(conn, table, canonical, cols.groupBy, parent);
    parent = canonical;
    columns.set(n, canonical);
    names.set(n, cols.nameColumn);
    levelColumns.set(n, cols);
    n++;
  }
  return { columns, names, schema: null, levelColumns };
}

// Throws on a missing code, or a code with more than one name, at any level.
async function checkCodesAndNames(
  conn: AsyncDuckDBConnection,
  table: string,
  side: SideLevels,
): Promise<void> {
  const present = await columnSet(conn, table);
  const qTable = quoteIdent(table);
  for (const n of [...side.columns.keys()].sort((a, b) => a - b)) {
    const code = side.columns.get(n)!;
    const qCode = quoteIdent(code);
    const r = (
      await conn.query(
        `SELECT COUNT(*) AS n FROM ${qTable} WHERE ${qCode} IS NULL OR trim(${qCode}::VARCHAR) = ''`,
      )
    ).toArray()[0] as { n: number | bigint };
    const missing = Number(r.n);
    if (missing > 0) {
      throw new Error(
        `level ${n} (${JSON.stringify(code)}) has ${missing} row(s) with no code in ${table}`,
      );
    }
    const name = side.names.get(n) ?? null;
    if (name === null || !present.has(name)) continue;
    const m = (
      await conn.query(`--sql
        SELECT COUNT(*) AS n FROM (
          SELECT ${qCode} FROM ${qTable} GROUP BY 1
          HAVING COUNT(DISTINCT ${quoteIdent(name)}) > 1
        )
      `)
    ).toArray()[0] as { n: number | bigint };
    const mixed = Number(m.n);
    if (mixed > 0) {
      throw new Error(
        `level ${n}: ${mixed} ${JSON.stringify(code)} value(s) in ${table} have more than one ${JSON.stringify(name)} value`,
      );
    }
  }
}

export interface ResolvedSideLevels {
  sideA: SideLevels;
  sideB: SideLevels;
  fmt: CodeFormat;
}

// Resolves OLD/NEW per-level columns; detects (or accepts an override for) fmt.
// A null override is detected from OLD; delimiter "" means codes have none.
export async function resolveSideLevels(
  conn: AsyncDuckDBConnection,
  oldTable: string,
  newTable: string,
  geomTables: [old: string, new: string],
  schemaA: TargetSchema | null,
  schemaB: TargetSchema | null,
  rootCode: string | null,
  delimiter: string | null,
  minWidth: string | null,
): Promise<ResolvedSideLevels> {
  const sideA = await resolveSide(conn, oldTable, geomTables[0], schemaA);
  const sideB = await resolveSide(conn, newTable, geomTables[1], schemaB, true);

  const levelsA = [...sideA.columns.keys()].sort((a, b) => a - b);
  const levelsB = [...sideB.columns.keys()].sort((a, b) => a - b);
  if (levelsA.join(",") !== levelsB.join(",")) {
    throw new Error(
      `level mismatch between old (${levelsA.join(", ")}) and new (${levelsB.join(", ")}); a real level-count change needs a human decision, not an automatic pass`,
    );
  }
  await checkCodesAndNames(conn, oldTable, sideA);
  await checkCodesAndNames(conn, newTable, sideB);

  let detected: CodeFormat | null = null;
  if (rootCode === null || delimiter === null || minWidth === null) {
    const finestColumn = sideA.columns.get(Math.max(...levelsA))!;
    detected =
      delimiter === "" ||
      (delimiter === null && !(await hasDelimiter(conn, oldTable, finestColumn)))
        ? await detectUndelimitedFormat(conn, oldTable, sideA.columns)
        : await detectCodeFormat(conn, oldTable, finestColumn);
  }
  const fmt: CodeFormat = {
    rootCode: rootCode ?? detected!.rootCode,
    delimiter: delimiter ?? detected!.delimiter,
    minWidth: minWidth !== null ? parseMinWidth(minWidth) : detected!.minWidth,
  };
  if (fmt.delimiter === "" && fmt.minWidth === "auto") {
    throw new Error("min width auto needs a delimiter; without one, widths must match OLD's");
  }
  checkLevelCount(fmt, levelsA.length);
  return { sideA, sideB, fmt };
}
