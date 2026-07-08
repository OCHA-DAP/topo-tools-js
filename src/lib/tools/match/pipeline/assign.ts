import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { computeOverlapPairs, type OverlapMethod } from "$lib/db/overlap";

export interface AssignResult {
  method: OverlapMethod;
  groupCount: number;
  assignedCount: number;
  unassignedCount: number;
}

// Assigns each child unit to the parent unit it has the largest area-overlap
// with (plurality, not necessarily >50%). Writes:
//   ge_assignment(child_fid, parent_fid) — one row per assigned child unit
//   ge_unassigned(fid, geom)             — child units with zero parent overlap
//   ge_groups(parent_fid, child_count)   — one row per non-empty group
export async function computeAssignment(conn: AsyncDuckDBConnection): Promise<AssignResult> {
  const method = await computeOverlapPairs(conn, "child_layer_01", "parent_layer_01", "ge_pairs");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_assignment AS
    SELECT a_fid AS child_fid, b_fid AS parent_fid
    FROM (
      SELECT a_fid, b_fid,
             ROW_NUMBER() OVER (PARTITION BY a_fid ORDER BY shared_area DESC, b_fid ASC) AS rn
      FROM ge_pairs
    )
    WHERE rn = 1
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_unassigned AS
    SELECT fid, geom FROM child_layer_01
    WHERE fid NOT IN (SELECT child_fid FROM ge_assignment)
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_groups AS
    SELECT parent_fid, COUNT(*) AS child_count
    FROM ge_assignment
    GROUP BY parent_fid
    ORDER BY parent_fid
  `);

  const [assigned, unassigned, groups] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM ge_assignment"),
    conn.query("SELECT COUNT(*) AS n FROM ge_unassigned"),
    conn.query("SELECT COUNT(*) AS n FROM ge_groups"),
  ]);

  // ge_pairs (every fine x nearby-coarse candidate pair) is only an
  // intermediate for the three tables above — nothing downstream reads it,
  // so free it now rather than letting it sit through the whole per-group
  // loop and the final memory-heavy assembly steps.
  await conn.query("DROP TABLE IF EXISTS ge_pairs");

  return {
    method,
    assignedCount: Number((assigned.toArray()[0] as { n: bigint | number }).n),
    unassignedCount: Number((unassigned.toArray()[0] as { n: bigint | number }).n),
    groupCount: Number((groups.toArray()[0] as { n: bigint | number }).n),
  };
}
