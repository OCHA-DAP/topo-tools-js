import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  EXCLUDED_COLUMNS,
  isNoiseColumn,
  NOTE_AMBIGUOUS,
  NOTE_SUPPLEMENTAL,
  WINNER_MAX_COLLAPSE_RATIO,
} from "./constants";
import {
  bijective,
  combinedDistinctCount,
  containmentHolds,
  distinctCounts,
  embeds,
  looksCodeShaped,
} from "./queries";
import type { TargetSchema } from "./targetSchema";

export interface CrosswalkRow {
  sourceColumn: string;
  targetColumn: string | null;
  note: string;
  role: "code" | "name" | null;
  level: number | null;
  uniqueCount: number;
}

interface Group {
  count: number;
  cols: string[];
}

export async function candidateColumns(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  const rows = desc.toArray() as Array<{ column_name: string }>;
  return rows
    .map((r) => r.column_name)
    .filter((c) => !EXCLUDED_COLUMNS.has(c) && !isNoiseColumn(c));
}

// Union pairwise-bijective same-count columns into one cluster; a
// non-bijective third column stays its own singleton, not discarded.
async function clusterByBijection(
  conn: AsyncDuckDBConnection,
  table: string,
  cols: string[],
): Promise<string[][]> {
  const parent = new Map(cols.map((c) => [c, c]));
  const find = (c: string): string => {
    while (parent.get(c) !== c) {
      parent.set(c, parent.get(parent.get(c)!)!);
      c = parent.get(c)!;
    }
    return c;
  };
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      if (await bijective(conn, table, cols[i], cols[j])) {
        parent.set(find(cols[i]), find(cols[j]));
      }
    }
  }
  const clusters = new Map<string, string[]>();
  for (const c of cols) {
    const root = find(c);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(c);
  }
  return Array.from(clusters.values());
}

async function buildLevelGroups(
  conn: AsyncDuckDBConnection,
  table: string,
  columns: string[],
  counts: Record<string, number>,
): Promise<Group[]> {
  const byCount = new Map<number, string[]>();
  for (const c of columns) {
    const n = counts[c];
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n)!.push(c);
  }
  const groups: Group[] = [];
  for (const [count, cols] of byCount) {
    for (const cluster of await clusterByBijection(conn, table, cols)) {
      groups.push({ count, cols: cluster });
    }
  }
  groups.sort((a, b) => a.count - b.count);
  return groups;
}

async function allContainmentHolds(
  conn: AsyncDuckDBConnection,
  table: string,
  coarserCols: string[],
  finerCols: string[],
): Promise<boolean> {
  for (const a of coarserCols) {
    for (const b of finerCols) {
      if (!(await containmentHolds(conn, table, a, b))) return false;
    }
  }
  return true;
}

async function anyEmbeds(
  conn: AsyncDuckDBConnection,
  table: string,
  coarserCols: string[],
  finerCols: string[],
): Promise<boolean> {
  for (const a of coarserCols) {
    for (const b of finerCols) {
      if (await embeds(conn, table, b, a)) return true;
    }
  }
  return false;
}

// Longest-path DP over the full containment/embedding DAG. A non-constant
// edge needs embedding justification unless no pair in the file embeds at all.
async function buildChain(
  conn: AsyncDuckDBConnection,
  table: string,
  groups: Group[],
): Promise<Group[]> {
  const n = groups.length;
  if (n === 0) return [];

  const edges = new Map<string, { joins: boolean; embeds: boolean }>();
  for (let finerIdx = 0; finerIdx < n; finerIdx++) {
    for (let coarserIdx = 0; coarserIdx < finerIdx; coarserIdx++) {
      const coarserCols = groups[coarserIdx].cols;
      const finerCols = groups[finerIdx].cols;
      const joins = await allContainmentHolds(conn, table, coarserCols, finerCols);
      const hasEmbedding = joins && (await anyEmbeds(conn, table, coarserCols, finerCols));
      edges.set(`${coarserIdx},${finerIdx}`, { joins, embeds: hasEmbedding });
    }
  }
  const noEmbeddingAnywhere = ![...edges.values()].some((e) => e.embeds);

  const bestLen = new Array<number>(n).fill(1);
  const bestPrev = new Array<number | null>(n).fill(null);
  for (let finerIdx = 0; finerIdx < n; finerIdx++) {
    for (let coarserIdx = 0; coarserIdx < finerIdx; coarserIdx++) {
      const edge = edges.get(`${coarserIdx},${finerIdx}`)!;
      if (!edge.joins) continue;
      const justified = groups[coarserIdx].count === 1 || edge.embeds || noEmbeddingAnywhere;
      if (justified && bestLen[coarserIdx] + 1 > bestLen[finerIdx]) {
        bestLen[finerIdx] = bestLen[coarserIdx] + 1;
        bestPrev[finerIdx] = coarserIdx;
      }
    }
  }

  let end = 0;
  for (let i = 1; i < n; i++) {
    const cur = [bestLen[i], groups[i].cols.length, groups[i].count];
    const best = [bestLen[end], groups[end].cols.length, groups[end].count];
    const better =
      cur[0] !== best[0] ? cur[0] > best[0] : cur[1] !== best[1] ? cur[1] > best[1] : cur[2] > best[2];
    if (better) end = i;
  }
  const chainIndices: number[] = [];
  let i: number | null = end;
  while (i !== null) {
    chainIndices.push(i);
    i = bestPrev[i];
  }
  chainIndices.reverse();
  return chainIndices.map((idx) => groups[idx]);
}

function numberedTarget(template: string, level: number, index: number): string {
  const rendered = template.replace("{n}", String(level));
  return index === 0 ? rendered : `${rendered}${index}`;
}

// Each column's role comes from its own evidence only, never a sibling's:
// a same-cardinality column like area_sqkm could otherwise steal "name".
async function assignChainRoles(
  conn: AsyncDuckDBConnection,
  table: string,
  chain: Group[],
  schema: TargetSchema,
  counts: Record<string, number>,
): Promise<Map<string, CrosswalkRow>> {
  const rows = new Map<string, CrosswalkRow>();
  for (let index = 0; index < chain.length; index++) {
    const { count, cols } = chain[index];
    if (count === 1) continue;
    const level = index;
    const parentCols = index > 0 ? chain[index - 1].cols : [];

    const roles = new Map<string, "code" | "name">();
    for (const c of cols) {
      let embedsParent = false;
      for (const p of parentCols) {
        if (await embeds(conn, table, c, p)) {
          embedsParent = true;
          break;
        }
      }
      const isCode = embedsParent || (await looksCodeShaped(conn, table, c));
      roles.set(c, isCode ? "code" : "name");
    }

    const parentCode = parentCols.length > 0 ? parentCols[0] : null;
    const templates: Array<["code" | "name", string]> = [
      ["code", schema.codeField],
      ["name", schema.nameField],
    ];
    for (const [role, template] of templates) {
      const members = cols.filter((c) => roles.get(c) === role);
      for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
        const column = members[memberIndex];
        const uniqueCount =
          parentCode === null
            ? counts[column]
            : await combinedDistinctCount(conn, table, parentCode, column);
        rows.set(column, {
          sourceColumn: column,
          targetColumn: numberedTarget(template, level, memberIndex),
          note: "",
          role,
          level,
          uniqueCount,
        });
      }
    }
  }
  return rows;
}

// Sole chain index k where codeCounts[k-1] < count <= codeCounts[k]
// (below the coarsest level is treated as a virtual count of 0).
function bracketIndex(codeCounts: number[], count: number): number | null {
  let lower = 0;
  for (let index = 0; index < codeCounts.length; index++) {
    const upper = codeCounts[index];
    if (lower < count && count <= upper) return index;
    lower = upper;
  }
  return null;
}

// A winner is a function of the level's code column. A non-bijective winner
// with a low collapse ratio is a numbered sibling; a coarser one is supplemental.
async function bracketLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  chain: Group[],
  level: number,
  candidates: string[],
  counts: Record<string, number>,
  schema: TargetSchema,
  chainRows: Map<string, CrosswalkRow>,
): Promise<Map<string, CrosswalkRow>> {
  const codeColumn = chain[level].cols[0];
  const winners = new Set<string>();
  for (const c of candidates) {
    if (await containmentHolds(conn, table, c, codeColumn)) winners.add(c);
  }
  const existingNameMembers = chain[level].cols.filter((m) => chainRows.get(m)?.role === "name");
  const levelHasName = existingNameMembers.length > 0;
  const levelUnitCount = chain[level].count;
  const parentCodeColumn = level > 0 ? chain[level - 1].cols[0] : null;

  const uniqueCountFor = async (column: string): Promise<number> =>
    parentCodeColumn === null
      ? counts[column]
      : combinedDistinctCount(conn, table, parentCodeColumn, column);

  const rows = new Map<string, CrosswalkRow>();
  let winnerIndex = existingNameMembers.length;
  for (const column of candidates) {
    const uniqueCount = await uniqueCountFor(column);
    const collapseRatio = levelUnitCount > 0 ? 1 - counts[column] / levelUnitCount : 1;
    if (!winners.has(column)) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: `${NOTE_AMBIGUOUS}, level ${level}`,
        role: null,
        level,
        uniqueCount,
      });
    } else if (levelHasName && collapseRatio > WINNER_MAX_COLLAPSE_RATIO) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: `${NOTE_SUPPLEMENTAL}, superset of level ${level}`,
        role: null,
        level,
        uniqueCount,
      });
    } else if (levelHasName) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: numberedTarget(schema.nameField, level, winnerIndex),
        note: "",
        role: "name",
        level,
        uniqueCount,
      });
      winnerIndex += 1;
    } else {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: numberedTarget(schema.nameField, level, winnerIndex),
        note: "",
        role: "name",
        level,
        uniqueCount,
      });
      winnerIndex += 1;
    }
  }
  return rows;
}

async function bracketOtherColumns(
  conn: AsyncDuckDBConnection,
  table: string,
  chain: Group[],
  otherColumns: string[],
  counts: Record<string, number>,
  schema: TargetSchema,
  chainRows: Map<string, CrosswalkRow>,
): Promise<Map<string, CrosswalkRow>> {
  const codeCounts = chain.map((g) => g.count);
  const bracketed = new Map<number, string[]>();
  for (const column of otherColumns) {
    const idx = bracketIndex(codeCounts, counts[column]);
    if (idx !== null) {
      if (!bracketed.has(idx)) bracketed.set(idx, []);
      bracketed.get(idx)!.push(column);
    }
  }
  const rows = new Map<string, CrosswalkRow>();
  for (const [level, candidates] of bracketed) {
    if (chain[level].count === 1) continue;
    const levelRows = await bracketLevel(
      conn,
      table,
      chain,
      level,
      candidates,
      counts,
      schema,
      chainRows,
    );
    for (const [k, v] of levelRows) rows.set(k, v);
  }
  return rows;
}

function sortKey(row: CrosswalkRow, sourcePosition: number): [number, number, number, number] {
  if (row.level === null) return [1, 0, 0, sourcePosition];
  const rolePriority = row.role === "name" ? 0 : 1;
  return [0, -row.level, rolePriority, sourcePosition];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export async function inferSchemaMap(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema,
): Promise<CrosswalkRow[]> {
  const columns = await candidateColumns(conn, table);
  const counts = await distinctCounts(conn, table, columns);

  // An all-null column has no evidence either way, same principle as embeds().
  const chainableColumns = columns.filter((c) => counts[c] > 0);
  const levelGroups = await buildLevelGroups(conn, table, chainableColumns, counts);
  const chain = await buildChain(conn, table, levelGroups);

  const rows = await assignChainRoles(conn, table, chain, schema, counts);

  const chainedColumns = new Set(chain.flatMap((g) => g.cols));
  const otherColumns = columns.filter((c) => !chainedColumns.has(c));
  const otherRows = await bracketOtherColumns(
    conn,
    table,
    chain,
    otherColumns,
    counts,
    schema,
    rows,
  );
  for (const [k, v] of otherRows) rows.set(k, v);

  for (const column of columns) {
    if (!rows.has(column)) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: "",
        role: null,
        level: null,
        uniqueCount: counts[column],
      });
    }
  }

  const position = new Map(columns.map((c, i) => [c, i]));
  const entries = columns.map((c) => rows.get(c)!);
  entries.sort((a, b) =>
    compareKeys(
      sortKey(a, position.get(a.sourceColumn)!),
      sortKey(b, position.get(b.sourceColumn)!),
    ),
  );
  return entries;
}
