import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Optional code-join precedence with spatial fallback, shared by
// assignOne.ts and match/pipeline/assign.ts (docs/adr/0045).

export interface MatchColumnOptions {
  matchColumn?: string;
  parentMatchColumn?: string;
  childMatchColumn?: string;
}

export interface ResolvedMatchColumns {
  parentMatchColumn: string;
  childMatchColumn: string;
}

export type AssignmentMethod = "code" | "spatial_fallback";

// `matchColumn` and `parentMatchColumn`/`childMatchColumn` are mutually
// exclusive (docs/reference/shared.md). Null return means no code join.
export function resolveMatchColumns(opts: MatchColumnOptions): ResolvedMatchColumns | null {
  const { matchColumn, parentMatchColumn, childMatchColumn } = opts;
  if (matchColumn != null) {
    if (parentMatchColumn != null || childMatchColumn != null) {
      throw new Error(
        "matchColumn is mutually exclusive with parentMatchColumn/childMatchColumn.",
      );
    }
    return { parentMatchColumn: matchColumn, childMatchColumn: matchColumn };
  }
  if (parentMatchColumn != null || childMatchColumn != null) {
    if (parentMatchColumn == null || childMatchColumn == null) {
      throw new Error("parentMatchColumn and childMatchColumn must both be given.");
    }
    return { parentMatchColumn, childMatchColumn };
  }
  return null;
}

interface CodeCandidatesOptions {
  childAttrTable: string;
  parentAttrTable: string;
  pairsTable: string;
  pairsChildCol: string;
  pairsParentCol: string;
  columns: ResolvedMatchColumns;
}

// Exact code join restricted to pairs already in pairsTable: a code match
// against a non-overlapping parent doesn't count (docs/adr/0045).
function codeCandidatesSql(o: CodeCandidatesOptions): string {
  const childCol = JSON.stringify(o.columns.childMatchColumn);
  const parentCol = JSON.stringify(o.columns.parentMatchColumn);
  return `
    SELECT c.fid AS child_fid, p.fid AS parent_fid
    FROM ${o.childAttrTable} c
    JOIN ${o.parentAttrTable} p ON c.${childCol} = p.${parentCol}
    JOIN ${o.pairsTable} pr ON pr.${o.pairsChildCol} = c.fid AND pr.${o.pairsParentCol} = p.fid
  `;
}

// Per-child code winner (match's granularity): one candidate parent per
// child, ties broken by the lowest parent fid.
export async function buildPerChildCodeWinners(
  conn: AsyncDuckDBConnection,
  o: CodeCandidatesOptions & { outputTable: string },
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${o.outputTable} AS
    SELECT child_fid, parent_fid FROM (
      SELECT child_fid, parent_fid,
             ROW_NUMBER() OVER (PARTITION BY child_fid ORDER BY parent_fid ASC) AS rn
      FROM (${codeCandidatesSql(o)})
    ) WHERE rn = 1
  `);
}

// Per-file/run code vote (assign-one granularity): winning parent by count
// of code-matched children, ties broken by the lowest parent fid.
export async function pickFileCodeWinner(
  conn: AsyncDuckDBConnection,
  o: CodeCandidatesOptions,
): Promise<number | null> {
  const rows = (
    await conn.query(`--sql
      SELECT parent_fid, COUNT(DISTINCT child_fid) AS n_children
      FROM (${codeCandidatesSql(o)})
      GROUP BY parent_fid
      ORDER BY n_children DESC, parent_fid ASC
      LIMIT 1
    `)
  ).toArray() as Array<{ parent_fid: bigint | number }>;
  return rows.length > 0 ? Number(rows[0].parent_fid) : null;
}

export interface AssignmentOutcome {
  parentFid: number;
  assignmentMethod: AssignmentMethod;
  spatialAgrees: boolean | null;
}

// Code wins whenever a match exists, even disagreeing with spatial;
// spatial is the fallback when no code match exists (docs/adr/0045).
export function resolveAssignment(
  codeParentFid: number | null,
  spatialParentFid: number,
): AssignmentOutcome {
  if (codeParentFid != null) {
    return {
      parentFid: codeParentFid,
      assignmentMethod: "code",
      spatialAgrees: codeParentFid === spatialParentFid,
    };
  }
  return { parentFid: spatialParentFid, assignmentMethod: "spatial_fallback", spatialAgrees: null };
}

// Combines per-child code and spatial winners: code wins on disagreement,
// spatial is the fallback. A child in neither table is absent here.
export async function combinePerChildAssignment(
  conn: AsyncDuckDBConnection,
  o: { codeWinnersTable: string; spatialTable: string; outputTable: string },
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${o.outputTable} AS
    SELECT
      COALESCE(code.child_fid, spatial.child_fid) AS child_fid,
      COALESCE(code.parent_fid, spatial.parent_fid) AS parent_fid,
      CASE WHEN code.parent_fid IS NOT NULL THEN 'code' ELSE 'spatial_fallback' END AS assignment_method,
      CASE WHEN code.parent_fid IS NOT NULL THEN code.parent_fid = spatial.parent_fid END AS spatial_agrees
    FROM ${o.codeWinnersTable} code
    FULL OUTER JOIN ${o.spatialTable} spatial USING (child_fid)
  `);
}
