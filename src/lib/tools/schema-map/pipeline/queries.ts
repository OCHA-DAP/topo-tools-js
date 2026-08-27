import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { CODE_SHAPE_MAJORITY } from "./constants";

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function num(v: number | bigint): number {
  return Number(v);
}

// One query, COUNT(DISTINCT) for every column, keyed by column name.
export async function distinctCounts(
  conn: AsyncDuckDBConnection,
  table: string,
  columns: string[],
): Promise<Record<string, number>> {
  if (columns.length === 0) return {};
  const select = columns
    .map((c, i) => `COUNT(DISTINCT ${quoteIdent(c)}) AS "__dc_${i}"`)
    .join(", ");
  const r = await conn.query(`SELECT ${select} FROM ${table}`);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const out: Record<string, number> = {};
  columns.forEach((c, i) => {
    out[c] = num(row[`__dc_${i}`]);
  });
  return out;
}

// Every non-null row has `child` contain `parent`, tolerating one sentinel.
// An all-null `parent`, or every failure sharing one value, is no evidence.
export async function embeds(
  conn: AsyncDuckDBConnection,
  table: string,
  child: string,
  parent: string,
): Promise<boolean> {
  const qc = quoteIdent(child);
  const qp = quoteIdent(parent);
  const evaluatedWhere = `${qc} IS NOT NULL AND ${qp} IS NOT NULL`;
  const notContains = `NOT contains(CAST(${qc} AS VARCHAR), CAST(${qp} AS VARCHAR))`;
  const r = await conn.query(`
    SELECT
      COUNT(*) FILTER (WHERE ${evaluatedWhere}) AS evaluated,
      COUNT(*) FILTER (WHERE ${evaluatedWhere} AND ${notContains}) AS bad
    FROM ${table}
  `);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const evaluated = num(row.evaluated);
  const bad = num(row.bad);
  if (bad === 0) return evaluated > 0;

  const culpritsRes = await conn.query(`
    SELECT DISTINCT CAST(${qc} AS VARCHAR) AS v
    FROM ${table}
    WHERE ${evaluatedWhere} AND ${notContains}
  `);
  const culprits = culpritsRes.toArray() as Array<{ v: string }>;
  if (culprits.length !== 1) return false;

  const remainingRes = await conn.query(`
    SELECT COUNT(*) AS n FROM ${table}
    WHERE ${evaluatedWhere} AND CAST(${qc} AS VARCHAR) != ${quoteLiteral(culprits[0].v)}
  `);
  return num((remainingRes.toArray()[0] as { n: number | bigint }).n) > 0;
}

// Majority non-null values (cast to string) contain a digit; only consulted
// when a column has no embedding evidence to pick code vs name by.
export async function looksCodeShaped(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const qc = quoteIdent(column);
  const r = await conn.query(`
    SELECT
      COUNT(*) FILTER (WHERE regexp_matches(CAST(${qc} AS VARCHAR), '[0-9]')) AS digits,
      COUNT(*) FILTER (WHERE ${qc} IS NOT NULL) AS total
    FROM ${table}
  `);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const total = num(row.total);
  return total > 0 && num(row.digits) / total > CODE_SHAPE_MAJORITY;
}

// Every `finer` maps to one `coarser`, tolerating one violating value
// (a single missing-value sentinel, e.g. a repeated "No_Pcode" string).
export async function containmentHolds(
  conn: AsyncDuckDBConnection,
  table: string,
  coarser: string,
  finer: string,
): Promise<boolean> {
  const qc = quoteIdent(coarser);
  const qf = quoteIdent(finer);
  const r = await conn.query(`
    SELECT ${qf} AS v FROM ${table}
    GROUP BY ${qf}
    HAVING COUNT(DISTINCT ${qc}) > 1
  `);
  return r.toArray().length <= 1;
}

export async function bijective(
  conn: AsyncDuckDBConnection,
  table: string,
  a: string,
  b: string,
): Promise<boolean> {
  return (
    (await containmentHolds(conn, table, a, b)) && (await containmentHolds(conn, table, b, a))
  );
}

// COUNT(DISTINCT (parent, column)), catching a value reused across parents.
export async function combinedDistinctCount(
  conn: AsyncDuckDBConnection,
  table: string,
  parent: string,
  column: string,
): Promise<number> {
  const qp = quoteIdent(parent);
  const qc = quoteIdent(column);
  const r = await conn.query(`
    SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT ${qp}, ${qc} FROM ${table}
    )
  `);
  return num((r.toArray()[0] as { n: number | bigint }).n);
}
