import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { siblingName } from "$lib/db/adminColumns";
import { isTemporalDuckdbType } from "$lib/db/columnTypes";
import {
  EXCLUDED_COLUMNS,
  isNoiseColumn,
  MIN_ROOT_EVIDENCE_COLUMNS,
  MIN_TIED_CODES,
  NOTE_AMBIGUOUS,
  NOTE_SUPPLEMENTAL,
  WINNER_MAX_COLLAPSE_RATIO,
} from "./constants";
import { commonPrefix, reversed } from "./naming";
import {
  bijective,
  columnTypes,
  combinedDistinctCount,
  containmentHolds,
  containmentPerfect,
  correspondsOnJointRows,
  distinctCounts,
  embeds,
  fractionalColumns,
  fullyPopulated,
  hasGeometryColumn,
  isNearRowUnique,
  looksCodeShaped,
  nonFloating,
  sameCoverage,
  spatiallyCoherent,
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

export type ResolvedColumn = CrosswalkRow;

const LEVEL_DIGIT_RE = /\d+/;

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

async function temporalColumns(
  conn: AsyncDuckDBConnection,
  table: string,
  columns: string[],
): Promise<Set<string>> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  const rows = desc.toArray() as Array<{ column_name: string; column_type: string }>;
  const types = new Map(rows.map((r) => [r.column_name, r.column_type]));
  return new Set(columns.filter((c) => isTemporalDuckdbType(types.get(c) ?? "")));
}

async function buildLevelGroups(
  conn: AsyncDuckDBConnection,
  table: string,
  columns: string[],
  counts: Record<string, number>,
): Promise<Group[]> {
  const groups: Group[] = [];
  for (const cluster of await clusterByBijection(conn, table, columns, counts)) {
    const count = Math.max(...cluster.map((c) => counts[c]));
    groups.push({ count, cols: cluster });
  }
  groups.sort((a, b) => a.count - b.count);
  return groups;
}

// Union fully-populated columns of equal count that correspond 1:1.
async function clusterDense(
  conn: AsyncDuckDBConnection,
  table: string,
  dense: string[],
  counts: Record<string, number>,
): Promise<string[][]> {
  const parent = new Map(dense.map((c) => [c, c]));
  const find = (c: string): string => {
    while (parent.get(c) !== c) {
      parent.set(c, parent.get(parent.get(c)!)!);
      c = parent.get(c)!;
    }
    return c;
  };
  for (let i = 0; i < dense.length; i++) {
    for (let j = i + 1; j < dense.length; j++) {
      const a = dense[i];
      const b = dense[j];
      // Two fully-populated constants always correspond, whatever the row count.
      if (counts[a] === counts[b] && (counts[a] === 1 || (await bijective(conn, table, a, b)))) {
        parent.set(find(a), find(b));
      }
    }
  }
  const clusters = new Map<string, string[]>();
  for (const c of dense) {
    const root = find(c);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(c);
  }
  return Array.from(clusters.values());
}

// Every candidate cluster `column` corresponds with on joint rows, member-wise.
async function matchingClusters(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
  candidates: string[][],
  coverage: boolean,
): Promise<string[][]> {
  const out: string[][] = [];
  for (const cl of candidates) {
    let all = true;
    for (const c of cl) {
      if (
        (coverage && !(await sameCoverage(conn, table, column, c))) ||
        !(await correspondsOnJointRows(conn, table, column, c))
      ) {
        all = false;
        break;
      }
    }
    if (all) out.push(cl);
  }
  return out;
}

// Group sparse columns populated on the same rows that correspond there.
async function groupByCoverage(
  conn: AsyncDuckDBConnection,
  table: string,
  sparse: string[],
): Promise<string[][]> {
  const groups: string[][] = [];
  for (const column of sparse) {
    const matches = await matchingClusters(conn, table, column, groups, true);
    if (matches.length === 1) matches[0].push(column);
    else groups.push([column]);
  }
  return groups;
}

// Every pair across group and cluster nests both ways, within tolerance.
async function nestsBothWays(
  conn: AsyncDuckDBConnection,
  table: string,
  group: string[],
  cluster: string[],
): Promise<boolean> {
  for (const a of group) {
    for (const b of cluster) {
      if (!(await containmentHolds(conn, table, a, b))) return false;
      if (!(await containmentHolds(conn, table, b, a))) return false;
    }
  }
  return true;
}

// Union bijective dense columns, then group or attach sparse ones on joint rows.
async function clusterByBijection(
  conn: AsyncDuckDBConnection,
  table: string,
  cols: string[],
  counts: Record<string, number>,
): Promise<string[][]> {
  const dense: string[] = [];
  for (const c of cols) if (await fullyPopulated(conn, table, c)) dense.push(c);
  const clusters = await clusterDense(conn, table, dense, counts);
  const denseClusters = clusters.filter((cl) => counts[cl[0]] > 1);
  // A sparse level's own columns share their rows, so they group first.
  const groups = await groupByCoverage(
    conn,
    table,
    cols.filter((c) => !dense.includes(c)),
  );
  const sparseClusters: string[][] = [];
  for (const group of groups.filter((g) => g.length > 1)) {
    // A group missing from one row only is that dense level with a stray gap.
    const homes: string[][] = [];
    for (const cl of denseClusters) {
      if (await nestsBothWays(conn, table, group, cl)) homes.push(cl);
    }
    if (homes.length === 1) homes[0].push(...group);
    else sparseClusters.push(group);
  }
  const ambiguous: string[][] = [];
  // A lone sparse column matching several clusters is ambiguous, so it joins none.
  for (const [column] of groups.filter((g) => g.length === 1)) {
    let matches = await matchingClusters(conn, table, column, denseClusters, false);
    if (matches.length === 0) {
      matches = await matchingClusters(conn, table, column, sparseClusters, false);
    }
    if (matches.length === 1) matches[0].push(column);
    else if (matches.length === 0) sparseClusters.push([column]);
    else ambiguous.push([column]);
  }
  return [...clusters, ...sparseClusters, ...ambiguous];
}

// Coarsest-first topological order by pairwise containment: a sparse-but-
// coarser group can otherwise sort after a dense-but-finer one by raw count.
async function orderGroupsByContainment(
  conn: AsyncDuckDBConnection,
  table: string,
  groups: Group[],
): Promise<Group[]> {
  const n = groups.length;
  const joins: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      joins[i][j] = await allContainmentHolds(conn, table, groups[i].cols, groups[j].cols);
    }
  }
  const indegree = new Array<number>(n)
    .fill(0)
    .map((_, i) => joins.reduce((acc, row) => acc + (row[i] ? 1 : 0), 0));
  const remaining = new Set<number>(Array.from({ length: n }, (_, i) => i));
  const order: number[] = [];
  while (remaining.size > 0) {
    const readyCandidates = [...remaining].filter((i) => indegree[i] === 0);
    const ready = readyCandidates.length > 0 ? readyCandidates : [...remaining];
    let best = ready[0];
    for (const i of ready) {
      if (
        groups[i].count < groups[best].count ||
        (groups[i].count === groups[best].count &&
          compareStringLists(groups[i].cols, groups[best].cols) < 0)
      ) {
        best = i;
      }
    }
    order.push(best);
    remaining.delete(best);
    for (const j of remaining) {
      if (joins[best][j]) indegree[j] -= 1;
    }
  }
  return order.map((i) => groups[i]);
}

// Python list ordering: element-wise, then a shorter prefix first.
function compareStringLists(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
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

interface Edge {
  joins: boolean;
  embeds: boolean;
  // Perfect containment into a near-row-unique finer group, with no embedding.
  strong: boolean;
}

type Edges = Map<string, Edge>;

function edgeKey(coarser: number, finer: number): string {
  return `${coarser},${finer}`;
}

// Non-floating members only: a fraction's digits satisfy embeds() by chance.
function embedWitnesses(types: Map<string, string>, columns: string[]): string[] {
  const witnesses = nonFloating(types, columns);
  return witnesses.length > 0 ? witnesses : columns;
}

async function buildEdges(
  conn: AsyncDuckDBConnection,
  table: string,
  groups: Group[],
  hasGeom: boolean,
): Promise<Edges> {
  const types = await columnTypes(conn, table);
  const edges: Edges = new Map();
  for (let finerIdx = 0; finerIdx < groups.length; finerIdx++) {
    const finerCols = groups[finerIdx].cols;
    const finerWitnesses = embedWitnesses(types, finerCols);
    const finerStrict = nonFloating(types, finerCols);
    let finerNearUnique = false;
    for (const c of finerStrict) {
      if (await isNearRowUnique(conn, table, c)) {
        finerNearUnique = true;
        break;
      }
    }
    for (let coarserIdx = 0; coarserIdx < finerIdx; coarserIdx++) {
      const coarserCols = groups[coarserIdx].cols;
      const joins = await allContainmentHolds(conn, table, coarserCols, finerCols);
      let hasEmbedding = false;
      if (joins) {
        outer: for (const a of embedWitnesses(types, coarserCols)) {
          for (const b of finerWitnesses) {
            if (await embeds(conn, table, b, a, hasGeom)) {
              hasEmbedding = true;
              break outer;
            }
          }
        }
      }
      let strong = false;
      if (joins && !hasEmbedding && finerNearUnique) {
        outer: for (const a of nonFloating(types, coarserCols)) {
          for (const b of finerStrict) {
            if (await containmentPerfect(conn, table, a, b)) {
              strong = true;
              break outer;
            }
          }
        }
      }
      edges.set(edgeKey(coarserIdx, finerIdx), { joins, embeds: hasEmbedding, strong });
    }
  }
  return edges;
}

// The naming digit most of a group's columns share, null on a tie.
function groupDigit(cols: string[]): number | null {
  const counts = new Map<number, number>();
  for (const c of cols) {
    const m = LEVEL_DIGIT_RE.exec(c);
    if (m !== null) counts.set(Number(m[0]), (counts.get(Number(m[0])) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null;
  return ranked[0][0];
}

// Edges bracketing a level whose digit sits exactly between its neighbours';
// a verified direct skip across it then needs no embedding of its own.
function bridgedEdges(groups: Group[], edges: Edges): Set<string> {
  const n = groups.length;
  const digits = groups.map((g) => groupDigit(g.cols));
  const bridged = new Set<string>();
  for (let k = 0; k < n; k++) {
    const dk = digits[k];
    if (dk === null) continue;
    for (let c = 0; c < k; c++) {
      const dc = digits[c];
      if (dc === null || dc >= dk || !edges.get(edgeKey(c, k))!.joins) continue;
      for (let f = k + 1; f < n; f++) {
        const df = digits[f];
        if (df === null || dk >= df) continue;
        if (edges.get(edgeKey(k, f))!.joins && edges.get(edgeKey(c, f))!.embeds) {
          bridged.add(edgeKey(c, k));
          bridged.add(edgeKey(k, f));
        }
      }
    }
  }
  return bridged;
}

interface ChainResult {
  chain: Group[];
  // Each dropped group with the child it nests.
  vetoed: Array<[string[], string[]]>;
}

// Longest-path DP over the containment/embedding DAG; a non-constant edge
// needs embedding justification unless no pair in the file embeds at all.
async function buildChain(
  conn: AsyncDuckDBConnection,
  table: string,
  groups: Group[],
): Promise<ChainResult> {
  const n = groups.length;
  if (n === 0) return { chain: [], vetoed: [] };

  const hasGeom = await hasGeometryColumn(conn, table);
  const edges = await buildEdges(conn, table, groups, hasGeom);
  const noEmbeddingAnywhere = ![...edges.values()].some((e) => e.embeds);
  const bridged = bridgedEdges(groups, edges);

  // Only an unbroken, fully-populated prefix from index 0 is a genuine root;
  // a sparse column can coincidentally have one distinct value.
  const inRootPrefix = new Array<boolean>(n).fill(false);
  let stillRoot = true;
  for (let idx = 0; idx < n; idx++) {
    let allPopulated = true;
    for (const c of groups[idx].cols) {
      if (!(await fullyPopulated(conn, table, c))) {
        allPopulated = false;
        break;
      }
    }
    inRootPrefix[idx] = stillRoot && groups[idx].count === 1 && allPopulated;
    stillRoot = inRootPrefix[idx];
  }

  const groupCodeShaped = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (const c of groups[i].cols) {
      if (await looksCodeShaped(conn, table, c)) {
        groupCodeShaped[i] = true;
        break;
      }
    }
  }

  const bestLen = new Array<number>(n).fill(1);
  const bestPrev = new Array<number | null>(n).fill(null);
  const bestEdgeEmbeds = new Array<boolean>(n).fill(false);
  const chainHasEmbed = new Array<boolean>(n).fill(false);
  for (let finerIdx = 0; finerIdx < n; finerIdx++) {
    for (let coarserIdx = 0; coarserIdx < finerIdx; coarserIdx++) {
      const edge = edges.get(edgeKey(coarserIdx, finerIdx))!;
      if (!edge.joins) continue;
      // A coincidentally-constant, non-root column can't extend a chain.
      if (groups[coarserIdx].count === 1 && !inRootPrefix[coarserIdx]) continue;

      // The root's freebie is unconditional only without geometry; with it,
      // an ungrounded finer group must corroborate.
      let rootFreebie = false;
      if (inRootPrefix[coarserIdx]) {
        if (edge.embeds || !hasGeom) {
          rootFreebie = true;
        } else {
          for (const c of groups[finerIdx].cols) {
            if (await spatiallyCoherent(conn, table, c)) {
              rootFreebie = true;
              break;
            }
          }
        }
      }
      const justified =
        rootFreebie ||
        edge.embeds ||
        (edge.strong && chainHasEmbed[coarserIdx]) ||
        noEmbeddingAnywhere ||
        bridged.has(edgeKey(coarserIdx, finerIdx));
      if (!justified) continue;

      const candidateLen = bestLen[coarserIdx] + 1;
      const prev = bestPrev[finerIdx];
      // On a tie, an embedded edge outranks an unembedded one, then a
      // code-shaped sibling outranks a name-shaped one.
      const better =
        candidateLen > bestLen[finerIdx] ||
        (candidateLen === bestLen[finerIdx] &&
          prev !== null &&
          compareBoolPairs(
            [edge.embeds, groupCodeShaped[coarserIdx]],
            [bestEdgeEmbeds[finerIdx], groupCodeShaped[prev]],
          ) > 0);
      if (better) {
        bestLen[finerIdx] = candidateLen;
        bestPrev[finerIdx] = coarserIdx;
        bestEdgeEmbeds[finerIdx] = edge.embeds;
        chainHasEmbed[finerIdx] = edge.embeds || chainHasEmbed[coarserIdx];
      }
    }
  }

  let end = 0;
  for (let i = 1; i < n; i++) {
    const cur = [bestLen[i], groups[i].cols.length, groups[i].count];
    const best = [bestLen[end], groups[end].cols.length, groups[end].count];
    const better =
      cur[0] !== best[0]
        ? cur[0] > best[0]
        : cur[1] !== best[1]
          ? cur[1] > best[1]
          : cur[2] > best[2];
    if (better) end = i;
  }
  let chainIndices: number[] = [];
  let i: number | null = end;
  while (i !== null) {
    chainIndices.push(i);
    i = bestPrev[i];
  }
  chainIndices.reverse();
  const veto = vetoUnanchoredGroupings(groups, edges, chainIndices, bestEdgeEmbeds, inRootPrefix);
  chainIndices = veto.chainIndices;
  return { chain: chainIndices.map((idx) => groups[idx]), vetoed: veto.vetoed };
}

function compareBoolPairs(a: [boolean, boolean], b: [boolean, boolean]): number {
  if (a[0] !== b[0]) return a[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] ? 1 : -1;
  return 0;
}

function pairShared(a: string, b: string): number {
  const prefix = commonPrefix([a, b]);
  const rest = [reversed(a.slice(prefix.length)), reversed(b.slice(prefix.length))];
  return prefix.length + commonPrefix(rest).length;
}

// Most prefix+suffix text one column per set shares, middles kept distinct.
function sharedNamingLength(columnSets: string[][]): number {
  let best = 0;
  const shortest = columnSets.reduce((m, s) => (s.length < m.length ? s : m));
  for (const reference of shortest) {
    const picked = columnSets.map((cols) =>
      cols.reduce((m, c) => (pairShared(reference, c) > pairShared(reference, m) ? c : m)),
    );
    const prefix = commonPrefix(picked);
    const rest = picked.map((p) => reversed(p.slice(prefix.length)));
    const suffixLength = commonPrefix(rest).length;
    const middles = rest.map((r) => r.slice(suffixLength));
    if (middles.every((m) => m !== "") && new Set(middles).size === middles.length) {
      best = Math.max(best, prefix.length + suffixLength);
    }
  }
  return best;
}

// Drop a level linked to its child only unembedded, the odd one out by naming.
function vetoUnanchoredGroupings(
  groups: Group[],
  edges: Edges,
  chainIndices: number[],
  bestEdgeEmbeds: boolean[],
  inRootPrefix: boolean[],
): { chainIndices: number[]; vetoed: Array<[string[], string[]]> } {
  const vetoed: Array<[string[], string[]]> = [];
  const embedded = [...bestEdgeEmbeds];
  let pos = 1;
  while (pos < chainIndices.length - 1) {
    const [parent, group, child] = chainIndices.slice(pos - 1, pos + 2);
    const withGroup = chainIndices.map((i) => groups[i].cols);
    const without = sharedNamingLength([...withGroup.slice(0, pos), ...withGroup.slice(pos + 1)]);
    const withoutChild = sharedNamingLength([
      ...withGroup.slice(0, pos + 1),
      ...withGroup.slice(pos + 2),
    ]);
    const parentChild = edges.get(edgeKey(parent, child))!;
    if (
      !embedded[child] &&
      !inRootPrefix[group] &&
      parentChild.joins &&
      without > Math.max(sharedNamingLength(withGroup), withoutChild)
    ) {
      vetoed.push([groups[group].cols, groups[child].cols]);
      embedded[child] = parentChild.embeds;
      chainIndices = [...chainIndices.slice(0, pos), ...chainIndices.slice(pos + 1)];
      pos = 1;
      continue;
    }
    pos += 1;
  }
  return { chainIndices, vetoed };
}

function numberedTarget(template: string, level: number, index: number): string {
  const rendered = template.replace("{n}", String(level));
  return index === 0 ? rendered : siblingName(rendered, index);
}

// Literal parts of template's own text that other's template lacks.
function roleMarkers(template: string, other: string): string[] {
  const otherParts = new Set(other.split("{n}"));
  return template.split("{n}").filter((p) => p !== "" && !otherParts.has(p));
}

// Name a nameless level's shape-only codes by the schema's own role markers.
function breakShapeTie(
  roles: Map<string, "code" | "name">,
  embedsParent: Map<string, boolean>,
  schema: TargetSchema,
): void {
  const shapeOnly = [...roles.keys()].filter(
    (c) => roles.get(c) === "code" && !embedsParent.get(c),
  );
  if ([...roles.values()].includes("name") || shapeOnly.length < MIN_TIED_CODES) return;
  const nameMarkers = roleMarkers(schema.nameField, schema.codeField);
  const codeMarkers = roleMarkers(schema.codeField, schema.nameField);
  const named = shapeOnly.filter(
    (c) => nameMarkers.some((m) => c.includes(m)) && !codeMarkers.some((m) => c.includes(m)),
  );
  if (named.length < shapeOnly.length) for (const c of named) roles.set(c, "name");
}

async function allFullyPopulated(
  conn: AsyncDuckDBConnection,
  table: string,
  cols: string[],
): Promise<boolean> {
  for (const c of cols) if (!(await fullyPopulated(conn, table, c))) return false;
  return true;
}

// Each column's role comes from its own evidence only, never a sibling's:
// a same-cardinality column like area_sqkm could otherwise steal "name".
async function assignChainRoles(
  conn: AsyncDuckDBConnection,
  table: string,
  chain: Group[],
  schema: TargetSchema,
  counts: Record<string, number>,
  offset: number,
): Promise<Map<string, CrosswalkRow>> {
  const rows = new Map<string, CrosswalkRow>();
  // A constant root folds away with no deeper level, or a fully-populated
  // one; a root above a partial deeper level is the only depth evidence.
  const nextFullyPopulated =
    chain.length > 1 && (await allFullyPopulated(conn, table, chain[1].cols));
  for (let index = 0; index < chain.length; index++) {
    const { count, cols } = chain[index];
    const isFoldableRoot = index === 0 && count === 1 && (chain.length === 1 || nextFullyPopulated);
    if (isFoldableRoot && (await fullyPopulated(conn, table, cols[0]))) continue;
    const level = index + offset;
    const parentCols = index > 0 ? chain[index - 1].cols : [];

    const embedsParent = new Map<string, boolean>();
    const roles = new Map<string, "code" | "name">();
    for (const c of cols) {
      let parentEmbedded = false;
      for (const p of parentCols) {
        if (await embeds(conn, table, c, p)) {
          parentEmbedded = true;
          break;
        }
      }
      embedsParent.set(c, parentEmbedded);
      const isCode = parentEmbedded || (await looksCodeShaped(conn, table, c));
      roles.set(c, isCode ? "code" : "name");
    }
    breakShapeTie(roles, embedsParent, schema);

    const parentCode = parentCols.length > 0 ? parentCols[0] : null;
    const templates: Array<["code" | "name", string]> = [
      ["code", schema.codeField],
      ["name", schema.nameField],
    ];
    for (const [role, template] of templates) {
      // A code embedding its parent outranks a surrogate ID for the bare name.
      const members = cols
        .filter((c) => roles.get(c) === role)
        .sort((a, b) => Number(!embedsParent.get(a)) - Number(!embedsParent.get(b)));
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
  offset: number,
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
  const levelN = level + offset;
  for (const column of candidates) {
    const uniqueCount = await uniqueCountFor(column);
    const collapseRatio = 1 - counts[column] / levelUnitCount;
    if (!winners.has(column)) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: `${NOTE_AMBIGUOUS}, level ${levelN}`,
        role: null,
        level: levelN,
        uniqueCount,
      });
    } else if (levelHasName && collapseRatio > WINNER_MAX_COLLAPSE_RATIO) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: `${NOTE_SUPPLEMENTAL}, superset of level ${levelN}`,
        role: null,
        level: levelN,
        uniqueCount,
      });
    } else {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: numberedTarget(schema.nameField, levelN, winnerIndex),
        note: "",
        role: "name",
        level: levelN,
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
  offset: number,
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
      offset,
    );
    for (const [k, v] of levelRows) rows.set(k, v);
  }
  return rows;
}

// Label each vetoed grouping supplemental over the chain level it nests.
function vetoedRows(
  chain: Group[],
  vetoed: Array<[string[], string[]]>,
  counts: Record<string, number>,
  offset: number,
): Map<string, CrosswalkRow> {
  const levelOf = new Map<string, number>();
  chain.forEach((g, index) => g.cols.forEach((c) => levelOf.set(c, index)));
  const rows = new Map<string, CrosswalkRow>();
  for (const [groupCols, childCols] of vetoed) {
    const childLevel = levelOf.get(childCols[0]);
    if (childLevel === undefined) continue;
    const levelN = childLevel + offset;
    for (const column of groupCols) {
      rows.set(column, {
        sourceColumn: column,
        targetColumn: null,
        note: `${NOTE_SUPPLEMENTAL}, superset of level ${levelN}`,
        role: null,
        level: levelN,
        uniqueCount: counts[column],
      });
    }
  }
  return rows;
}

// Resolve every candidate column to a level/role; `schema` only renders target
// names. `level` anchors the finest level; else impliedCountry numbers a varying root 1.
export async function resolveColumns(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema,
  level: number | null = null,
  impliedCountry = false,
): Promise<Map<string, ResolvedColumn>> {
  const columns = await candidateColumns(conn, table);
  const counts = await distinctCounts(conn, table, columns);

  // An all-null column has no evidence either way, same principle as embeds();
  // a date/time column is categorically never an admin identity column.
  const temporal = await temporalColumns(conn, table, columns);
  const fractional = await fractionalColumns(conn, table, columns);
  const chainableColumns = columns.filter(
    (c) => counts[c] > 0 && !temporal.has(c) && !fractional.has(c),
  );
  let levelGroups = await buildLevelGroups(conn, table, chainableColumns, counts);
  levelGroups = await orderGroupsByContainment(conn, table, levelGroups);
  const built = await buildChain(conn, table, levelGroups);
  let chain = built.chain;
  const vetoed = built.vetoed;
  // A lone level with a lone column has no parent to embed and no sibling
  // to pair with, indistinguishable from an arbitrary non-hierarchy column.
  if (chain.length === 1 && chain[0].cols.length < MIN_ROOT_EVIDENCE_COLUMNS) {
    chain = [];
  }

  let offset = 0;
  if (chain.length > 0 && level !== null) offset = level - (chain.length - 1);
  else if (chain.length > 0 && impliedCountry && chain[0].count > 1) offset = 1;
  const rows = await assignChainRoles(conn, table, chain, schema, counts, offset);
  const levels = [...rows.values()].flatMap((r) => (r.level === null ? [] : [r.level]));
  const lowest = levels.length > 0 ? Math.min(...levels) : 0;
  if (lowest < 0) {
    throw new Error(
      `level=${level} is too shallow: found ${chain.length} nested levels, so the coarsest would be ${lowest}`,
    );
  }

  const chainedColumns = new Set(chain.flatMap((g) => g.cols));
  const vetoRows = vetoedRows(chain, vetoed, counts, offset);
  const otherColumns = columns.filter(
    (c) => !chainedColumns.has(c) && !vetoRows.has(c) && !fractional.has(c),
  );
  const otherRows = await bracketOtherColumns(
    conn,
    table,
    chain,
    otherColumns,
    counts,
    schema,
    rows,
    offset,
  );
  for (const [k, v] of otherRows) rows.set(k, v);
  for (const [k, v] of vetoRows) rows.set(k, v);

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
  level: number | null = null,
): Promise<CrosswalkRow[]> {
  const columns = await candidateColumns(conn, table);
  const rows = await resolveColumns(conn, table, schema, level, true);

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
