import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { isTemporalDuckdbType } from "$lib/db/columnTypes";
import {
  CODE_SHAPE_MAJORITY,
  MIN_GROUPS_FOR_TOLERANCE,
  MIN_ROWS_FOR_SPATIAL_COHERENCE,
  MIN_SPATIAL_R2,
} from "./constants";

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

// Table has a `geom` column at all; not every caller loads one.
export async function hasGeometryColumn(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<boolean> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  const rows = desc.toArray() as Array<{ column_name: string }>;
  return rows.some((r) => r.column_name === "geom");
}

// `column` is non-null everywhere (a real constant, not a sparse one).
export async function fullyPopulated(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const qc = quoteIdent(column);
  const r = await conn.query(`SELECT COUNT(*) AS total, COUNT(${qc}) AS populated FROM ${table}`);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  return num(row.total) === num(row.populated);
}

// column's own groups explain most of the file's centroid spread; too
// little evidence (row count or spread) is not evidence against.
export async function spatiallyCoherent(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const qc = quoteIdent(column);
  const r = await conn.query(`
    WITH pts AS (
      SELECT ${qc} AS g, ST_X(ST_Centroid(geom)) AS cx, ST_Y(ST_Centroid(geom)) AS cy
      FROM ${table}
      WHERE ${qc} IS NOT NULL
    ),
    per_group AS (
      SELECT g, COUNT(*) AS n, VAR_POP(cx) AS vx, VAR_POP(cy) AS vy
      FROM pts GROUP BY g
    )
    SELECT
      SUM(n) AS total_rows,
      SUM(n * COALESCE(vx, 0)) / SUM(n) AS within_x,
      SUM(n * COALESCE(vy, 0)) / SUM(n) AS within_y,
      (SELECT VAR_POP(cx) FROM pts) AS total_x,
      (SELECT VAR_POP(cy) FROM pts) AS total_y
    FROM per_group
    HAVING COUNT(*) >= 2
  `);
  const rows = r.toArray();
  if (rows.length === 0) return true;
  const row = rows[0] as Record<string, number | bigint | null>;
  const totalRows = num(row.total_rows as number | bigint);
  if (totalRows < MIN_ROWS_FOR_SPATIAL_COHERENCE) return true;
  const totalX = row.total_x == null ? 0 : num(row.total_x);
  const totalY = row.total_y == null ? 0 : num(row.total_y);
  const total = totalX + totalY;
  if (total === 0) return true;
  const withinX = row.within_x == null ? 0 : num(row.within_x);
  const withinY = row.within_y == null ? 0 : num(row.within_y);
  const within = withinX + withinY;
  return 1 - within / total >= MIN_SPATIAL_R2;
}

// child contains parent on every evaluated row, tolerating one sentinel
// value only if child is also spatially coherent.
export async function embeds(
  conn: AsyncDuckDBConnection,
  table: string,
  child: string,
  parent: string,
  hasGeom = false,
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
  const remaining = num((remainingRes.toArray()[0] as { n: number | bigint }).n);
  if (remaining <= 0) return false;
  return !hasGeom || (await spatiallyCoherent(conn, table, child));
}

// Majority non-null values (cast to string) contain a digit; only consulted
// when a column has no embedding evidence, never true for a date/time column.
export async function looksCodeShaped(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  const descRows = desc.toArray() as Array<{ column_name: string; column_type: string }>;
  const columnType = descRows.find((r) => r.column_name === column)?.column_type ?? "";
  if (isTemporalDuckdbType(columnType)) return false;

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

// Every non-null finer maps to a single non-null coarser, mostly; the
// one-violator tolerance only applies past MIN_GROUPS_FOR_TOLERANCE groups.
export async function containmentHolds(
  conn: AsyncDuckDBConnection,
  table: string,
  coarser: string,
  finer: string,
): Promise<boolean> {
  const qc = quoteIdent(coarser);
  const qf = quoteIdent(finer);
  const r = await conn.query(`
    SELECT COUNT(DISTINCT ${qc}) AS coarser_count,
           COUNT(*) FILTER (WHERE ${qc} IS NULL) AS null_coarser
    FROM ${table}
    WHERE ${qf} IS NOT NULL
    GROUP BY ${qf}
  `);
  const groups = r.toArray() as Array<{
    coarser_count: number | bigint;
    null_coarser: number | bigint;
  }>;
  const violators = groups.filter(
    (g) => num(g.coarser_count) > 1 || num(g.null_coarser) > 0,
  ).length;
  const tolerance = groups.length > MIN_GROUPS_FOR_TOLERANCE ? 1 : 0;
  return violators <= tolerance;
}

export async function bijective(
  conn: AsyncDuckDBConnection,
  table: string,
  a: string,
  b: string,
): Promise<boolean> {
  return (await containmentHolds(conn, table, a, b)) && (await containmentHolds(conn, table, b, a));
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
