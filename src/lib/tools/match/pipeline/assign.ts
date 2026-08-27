import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { computeOverlapPairs } from "$lib/db/overlap";
import {
  buildPerChildCodeWinners,
  combinePerChildAssignment,
  type MatchColumnOptions,
  resolveMatchColumns,
} from "$lib/db/codeJoin";
import { PASSTHROUGH_PARENT_FID } from "./groups";

export interface AssignResult {
  groupCount: number;
  assignedCount: number;
  unassignedCount: number;
  codeMismatchCount: number;
  codeFallbackCount: number;
}

// Assigns each child to its largest-overlap parent (plurality); an optional
// code join wins over that pick wherever it disagrees (docs/adr/0045).
export async function computeAssignment(
  conn: AsyncDuckDBConnection,
  matchColumns: MatchColumnOptions = {},
  passthrough = false,
): Promise<AssignResult> {
  await computeOverlapPairs(conn, "child_layer_01", "parent_layer_01", "ge_pairs");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_spatial AS
    SELECT a_fid AS child_fid, b_fid AS parent_fid
    FROM (
      SELECT a_fid, b_fid,
             ROW_NUMBER() OVER (PARTITION BY a_fid ORDER BY shared_area DESC, b_fid ASC) AS rn
      FROM ge_pairs
    )
    WHERE rn = 1
  `);

  const resolvedCols = resolveMatchColumns(matchColumns);
  if (resolvedCols) {
    await buildPerChildCodeWinners(conn, {
      childAttrTable: "child_layer_attr",
      parentAttrTable: "parent_layer_attr",
      pairsTable: "ge_pairs",
      pairsChildCol: "a_fid",
      pairsParentCol: "b_fid",
      columns: resolvedCols,
      outputTable: "ge_code_winner",
    });
    await combinePerChildAssignment(conn, {
      codeWinnersTable: "ge_code_winner",
      spatialTable: "ge_spatial",
      outputTable: "ge_assignment",
    });
    await conn.query("DROP TABLE IF EXISTS ge_code_winner");
  } else {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ge_assignment AS
      SELECT child_fid, parent_fid,
             NULL::VARCHAR AS assignment_method, NULL::BOOLEAN AS spatial_agrees
      FROM ge_spatial
    `);
  }
  await conn.query("DROP TABLE IF EXISTS ge_spatial");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_unassigned AS
    SELECT fid, geom FROM child_layer_01
    WHERE fid NOT IN (SELECT child_fid FROM ge_assignment)
  `);

  // Opt-in: tag every zero-overlap child so it runs through the extend
  // pipeline unclipped, instead of only being reported as unassigned.
  if (passthrough) {
    await conn.query(`--sql
      INSERT INTO ge_assignment
      SELECT fid AS child_fid, ${PASSTHROUGH_PARENT_FID} AS parent_fid,
             NULL::VARCHAR AS assignment_method, NULL::BOOLEAN AS spatial_agrees
      FROM ge_unassigned
    `);
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_groups AS
    SELECT parent_fid, COUNT(*) AS child_count
    FROM ge_assignment
    GROUP BY parent_fid
    ORDER BY parent_fid
  `);

  const [assigned, unassigned, groups, codeStats] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM ge_assignment"),
    conn.query("SELECT COUNT(*) AS n FROM ge_unassigned"),
    conn.query("SELECT COUNT(*) AS n FROM ge_groups"),
    conn.query(`--sql
      SELECT
        COUNT(*) FILTER (WHERE assignment_method = 'code' AND spatial_agrees = FALSE) AS mismatch,
        COUNT(*) FILTER (WHERE assignment_method = 'spatial_fallback') AS fallback
      FROM ge_assignment
    `),
  ]);

  // ge_pairs is only an intermediate for the tables above; free it now
  // rather than letting it sit through the rest of the pipeline.
  await conn.query("DROP TABLE IF EXISTS ge_pairs");

  const codeRow = codeStats.toArray()[0] as { mismatch: bigint | number; fallback: bigint | number };
  return {
    assignedCount: Number((assigned.toArray()[0] as { n: bigint | number }).n),
    unassignedCount: Number((unassigned.toArray()[0] as { n: bigint | number }).n),
    groupCount: Number((groups.toArray()[0] as { n: bigint | number }).n),
    codeMismatchCount: Number(codeRow.mismatch),
    codeFallbackCount: Number(codeRow.fallback),
  };
}
