import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { resolveColumns, type ResolvedColumn } from "./inference";
import { quoteIdent } from "./queries";
import { DEFAULT_TARGET_SCHEMA } from "./targetSchema";

export interface LevelColumns {
  groupBy: string[];
  identityColumns: string[];
  hasCode: boolean;
  nameColumn: string | null;
}

const MIN_LEVELS_TO_DIFF = 2;
const LEVEL_DIGIT_RE = /\d+/;

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

function commonPrefixSuffix(names: string[]): [string, string] {
  const prefix = commonPrefix(names);
  const remainders = names.map((n) => n.slice(prefix.length));
  const reversedSuffix = commonPrefix(remainders.map((r) => [...r].reverse().join("")));
  const suffix = [...reversedSuffix].reverse().join("");
  return [prefix, suffix];
}

// Each level's own (prefix, anchor, suffix) split, diffed against every other.
function levelAnchors(codeColumns: Map<number, string>): Map<number, [string, string, string]> {
  if (codeColumns.size < MIN_LEVELS_TO_DIFF) return new Map();
  const [prefix, suffix] = commonPrefixSuffix([...codeColumns.values()]);
  const anchors = new Map<number, [string, string, string]>();
  for (const [level, name] of codeColumns) {
    const anchor = name.slice(prefix.length, name.length - suffix.length);
    if (anchor) anchors.set(level, [prefix, anchor, suffix]);
  }
  return anchors;
}

export function isLevelIdentityColumn(
  name: string,
  prefix: string,
  anchor: string,
  suffix: string,
): boolean {
  return name.startsWith(prefix + anchor) || name.endsWith(anchor + suffix);
}

function stripAnchor(column: string, prefix: string, anchor: string, suffix: string): string {
  if (column.startsWith(prefix + anchor)) return column.slice(prefix.length + anchor.length);
  return column.slice(0, column.length - anchor.length - suffix.length);
}

function maxCardinalityColumn(rows: Map<string, ResolvedColumn>, columns: string[]): string {
  return columns.reduce((best, c) =>
    rows.get(c)!.uniqueCount > rows.get(best)!.uniqueCount ? c : best,
  );
}

async function isFunctionallyDependent(
  conn: AsyncDuckDBConnection,
  table: string,
  canonicalColumn: string,
  column: string,
): Promise<boolean> {
  const qCanon = quoteIdent(canonicalColumn);
  const qOther = quoteIdent(column);
  const r = await conn.query(`
    SELECT MAX(variant_count) AS v FROM (
      SELECT COUNT(DISTINCT ${qOther}) FILTER (WHERE ${qOther} IS NOT NULL) AS variant_count
      FROM ${table}
      WHERE ${qCanon} IS NOT NULL
      GROUP BY ${qCanon}
    )
  `);
  const row = r.toArray()[0] as { v: number | bigint | null };
  return row.v == null || Number(row.v) <= 1;
}

// Renumbers each level to its own naming-anchor digit, when consistent;
// falls back to the structural level itself when no digit or unordered.
function displayLevels(
  codes: Map<number, string>,
  anchors: Map<number, [string, string, string]>,
): Map<number, number> {
  const ordered = [...codes.keys()].sort((a, b) => a - b);
  const identity = new Map(ordered.map((l) => [l, l]));
  const digits: number[] = [];
  for (const level of ordered) {
    const source = anchors.has(level) ? anchors.get(level)![1] : codes.get(level)!;
    const match = LEVEL_DIGIT_RE.exec(source);
    if (match === null) return identity;
    digits.push(Number(match[0]));
  }
  const sortedDigits = [...digits].sort((a, b) => a - b);
  const isSorted = digits.every((d, i) => d === sortedDigits[i]);
  const isUnique = new Set(digits).size === digits.length;
  if (!isSorted || !isUnique) return identity;
  const result = new Map<number, number>();
  ordered.forEach((level, i) => result.set(level, digits[i]));
  return result;
}

async function tableColumnNames(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

// Every column structurally tied to each admin level, in no particular naming.
export async function detectLevelColumns(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, LevelColumns>> {
  const rows = await resolveColumns(conn, table, DEFAULT_TARGET_SCHEMA);

  const allColumnsByLevel = new Map<number, string[]>();
  const groupByByLevel = new Map<number, string[]>();
  for (const [source, row] of rows) {
    if (row.level === null) continue;
    if (!allColumnsByLevel.has(row.level)) allColumnsByLevel.set(row.level, []);
    allColumnsByLevel.get(row.level)!.push(source);
    if (row.role !== null) {
      if (!groupByByLevel.has(row.level)) groupByByLevel.set(row.level, []);
      groupByByLevel.get(row.level)!.push(source);
    }
  }
  if (allColumnsByLevel.size === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }

  const codes = new Map<number, string>();
  for (const [level, cols] of groupByByLevel) codes.set(level, maxCardinalityColumn(rows, cols));
  const anchors = levelAnchors(codes);
  const display = displayLevels(codes, anchors);
  const assigned = new Set<string>();
  for (const cols of allColumnsByLevel.values()) for (const c of cols) assigned.add(c);
  const tableColumns = await tableColumnNames(conn, table);

  const rootLevel = Math.min(...allColumnsByLevel.keys());
  const result = new Map<number, LevelColumns>();
  for (const level of [...allColumnsByLevel.keys()].sort((a, b) => a - b)) {
    const groupBy = [...(groupByByLevel.get(level) ?? [])];
    // The root has no parent to embed, so its own shape is never diagnostic.
    const hasCode =
      level === rootLevel ||
      allColumnsByLevel.get(level)!.some((c) => rows.get(c)!.role === "code");
    const nameColumn = allColumnsByLevel.get(level)!.find((c) => rows.get(c)!.role === "name") ?? null;
    if (!anchors.has(level)) {
      result.set(level, {
        groupBy,
        identityColumns: [...allColumnsByLevel.get(level)!],
        hasCode,
        nameColumn,
      });
      continue;
    }

    const [prefix, anchor, suffix] = anchors.get(level)!;
    const completed: string[] = [];
    for (const c of tableColumns) {
      if (assigned.has(c)) continue;
      if (!isLevelIdentityColumn(c, prefix, anchor, suffix)) continue;
      if (await isFunctionallyDependent(conn, table, codes.get(level)!, c)) completed.push(c);
    }
    for (const c of completed) assigned.add(c);
    const identity = allColumnsByLevel
      .get(level)!
      .filter((c) => isLevelIdentityColumn(c, prefix, anchor, suffix))
      .concat(completed);
    result.set(level, {
      groupBy: groupBy.concat(completed),
      identityColumns: identity,
      hasCode,
      nameColumn,
    });
  }

  const finalResult = new Map<number, LevelColumns>();
  for (const [level, v] of result) finalResult.set(display.get(level) ?? level, v);
  return finalResult;
}

// detectLevelColumns, falling back to one ungrouped level for zero evidence.
export async function detectLevelColumnsOrSingle(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, LevelColumns>> {
  try {
    return await detectLevelColumns(conn, table);
  } catch {
    return new Map([[0, { groupBy: [], identityColumns: [], hasCode: true, nameColumn: null }]]);
  }
}

// Each level's least-collapsed column, never a bracketed/supplemental one.
export async function detectLevelCodes(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, string>> {
  const rows = await resolveColumns(conn, table, DEFAULT_TARGET_SCHEMA);
  const groupByByLevel = new Map<number, string[]>();
  for (const [source, row] of rows) {
    if (row.level !== null && row.role !== null) {
      if (!groupByByLevel.has(row.level)) groupByByLevel.set(row.level, []);
      groupByByLevel.get(row.level)!.push(source);
    }
  }
  if (groupByByLevel.size === 0) {
    throw new Error(`no admin hierarchy code column detected in ${table}`);
  }
  const codes = new Map<number, string>();
  for (const [level, cols] of groupByByLevel) codes.set(level, maxCardinalityColumn(rows, cols));
  const display = displayLevels(codes, levelAnchors(codes));
  const result = new Map<number, string>();
  for (const [level, column] of codes) result.set(display.get(level) ?? level, column);
  return result;
}

// Find an unassigned family's (prefix, anchor, suffix), or null if ambiguous.
async function rootAnchor(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<[string, string, string] | null> {
  const anchors = levelAnchors(await detectLevelCodes(conn, table));
  if (anchors.size === 0) return null;
  const [prefix, , suffix] = anchors.values().next().value!;
  const usedAnchors = new Set([...anchors.values()].map(([, a]) => a));

  const tableColumns = await tableColumnNames(conn, table);
  const assigned = new Set<string>();
  for (const cols of levelColumns.values()) for (const c of cols.identityColumns) assigned.add(c);

  const candidateAnchors = new Set<string>();
  for (const c of tableColumns) {
    if (assigned.has(c) || !c.startsWith(prefix) || !c.endsWith(suffix)) continue;
    if (c.length <= prefix.length + suffix.length) continue;
    candidateAnchors.add(c.slice(prefix.length, c.length - suffix.length));
  }
  for (const u of usedAnchors) candidateAnchors.delete(u);
  if (candidateAnchors.size !== 1) return null;
  return [prefix, [...candidateAnchors][0], suffix];
}

// A coarser, whole-table-constant level one below the finest one, completing
// the naming style the detected levels already established.
export async function detectRootLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<LevelColumns | null> {
  if (levelColumns.size === 0) return null;
  const root = await rootAnchor(conn, table, levelColumns);
  if (root === null) return null;
  const [prefix, anchor, suffix] = root;

  const tableColumns = await tableColumnNames(conn, table);
  const assigned = new Set<string>();
  for (const cols of levelColumns.values()) for (const c of cols.identityColumns) assigned.add(c);
  const candidates = tableColumns.filter(
    (c) => !assigned.has(c) && isLevelIdentityColumn(c, prefix, anchor, suffix),
  );
  if (candidates.length === 0) return null;

  const select = candidates
    .map(
      (c, i) =>
        `COUNT(DISTINCT ${quoteIdent(c)}) FILTER (WHERE ${quoteIdent(c)} IS NOT NULL) AS "__ra_${i}"`,
    )
    .join(", ");
  const r = await conn.query(`SELECT ${select} FROM ${table}`);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const rootColumns = candidates.filter((_c, i) => Number(row[`__ra_${i}`]) <= 1);
  if (rootColumns.length === 0) return null;
  return { groupBy: [], identityColumns: rootColumns, hasCode: true, nameColumn: null };
}

// Groups every level's identity columns by shared naming kind, across levels.
export async function groupFamiliesByLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<Map<string, Map<number, string>>> {
  const anchors = levelAnchors(await detectLevelCodes(conn, table));
  if (levelColumns.has(0) && !anchors.has(0)) {
    const realLevels = new Map([...levelColumns].filter(([k]) => k !== 0));
    const root = await rootAnchor(conn, table, realLevels);
    if (root !== null) anchors.set(0, root);
  }
  const families = new Map<string, Map<number, string>>();
  for (const [level, cols] of levelColumns) {
    if (!anchors.has(level)) continue;
    const [prefix, anchor, suffix] = anchors.get(level)!;
    for (const column of cols.identityColumns) {
      const kind = stripAnchor(column, prefix, anchor, suffix);
      if (!families.has(kind)) families.set(kind, new Map());
      families.get(kind)!.set(level, column);
    }
  }
  return families;
}

// Maps this level's own identity columns to a name shared across levels.
export function levelFamilyNames(
  families: Map<string, Map<number, string>>,
  level: number,
  codeColumn: string | null,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [kind, perLevel] of families) {
    const column = perLevel.get(level);
    if (column === undefined) continue;
    const stripped = kind.replace(/^_+|_+$/g, "");
    const generic = stripped || (column === codeColumn ? "code" : "name");
    names.set(column, generic);
  }
  return names;
}

// Throws if a cluster member takes more than one non-null value per group
// (per-column, not a raw tuple count: that treats an all-NULL row as a group).
export async function verifyFunctionalCluster(
  conn: AsyncDuckDBConnection,
  table: string,
  canonicalColumn: string,
  cluster: string[],
): Promise<void> {
  for (const other of cluster) {
    if (other === canonicalColumn) continue;
    if (!(await isFunctionallyDependent(conn, table, canonicalColumn, other))) {
      throw new Error(
        `${table}: grouping by ${JSON.stringify(cluster)} fragments ${JSON.stringify(canonicalColumn)}; ${JSON.stringify(other)} takes more than one non-null value within a group`,
      );
    }
  }
}
