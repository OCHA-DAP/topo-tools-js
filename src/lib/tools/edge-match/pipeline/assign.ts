import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignBestOverlap } from "$lib/db/assignBestOverlap";
import { assignOne } from "$lib/db/assignOne";
import {
  buildPerInputCodeWinners,
  combinePerInputAssignment,
  type MatchColumnOptions,
  resolveMatchColumns,
} from "$lib/db/codeJoin";
import { PASSTHROUGH_OVERLAY_FID } from "./groups";

export interface AssignResult {
  groupCount: number;
  assignedCount: number;
  unassignedCount: number;
  codeMismatchCount: number;
  codeFallbackCount: number;
  // Assign-one only: the majority-vote winner.
  overlayFid: number | null;
  // The mode actually run; "auto" resolves to one of the other two.
  mode: "one" | "many";
}

export type MatchMode = "auto" | "one" | "many";

// "one" puts the whole input onto its majority-vote overlay feature; "many"
// assigns each input feature to its largest overlap. "auto" picks "many" when
// fewer than half the input features overlap the majority-vote winner.
export async function computeAssignment(
  conn: AsyncDuckDBConnection,
  matchColumns: MatchColumnOptions = {},
  passthrough = false,
  mode: MatchMode = "one",
): Promise<AssignResult> {
  let one: Awaited<ReturnType<typeof assignOne>> | null = null;
  let many = mode === "many";
  if (!many) {
    one = await assignOne(conn, matchColumns);
    if (mode === "auto" && one.overlappingCount * 2 < one.assignedCount) {
      many = true;
      one = null;
      await conn.query("DROP TABLE IF EXISTS cl_assign");
    }
  }
  if (many) {
    await assignPerFeature(conn, matchColumns);
  } else if (one) {
    const method = one.assignmentMethod ? `'${one.assignmentMethod}'` : "NULL";
    const agrees = one.spatialAgrees == null ? "NULL" : String(one.spatialAgrees);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ge_assignment AS
      SELECT input_fid, overlay_fid,
             ${method}::VARCHAR AS assignment_method, ${agrees}::BOOLEAN AS spatial_agrees
      FROM cl_assign
    `);
    await conn.query("DROP TABLE IF EXISTS cl_assign");
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_unassigned AS
    SELECT fid, geom FROM input_layer_01
    WHERE fid NOT IN (SELECT input_fid FROM ge_assignment)
  `);

  // Opt-in: tag every zero-overlap input feature so it runs through the extend
  // pipeline unclipped, instead of only being reported as unassigned.
  if (passthrough) {
    await conn.query(`--sql
      INSERT INTO ge_assignment
      SELECT fid AS input_fid, ${PASSTHROUGH_OVERLAY_FID} AS overlay_fid,
             NULL::VARCHAR AS assignment_method, NULL::BOOLEAN AS spatial_agrees
      FROM ge_unassigned
    `);
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_groups AS
    SELECT overlay_fid, COUNT(*) AS input_count
    FROM ge_assignment
    GROUP BY overlay_fid
    ORDER BY overlay_fid
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

  const codeRow = codeStats.toArray()[0] as {
    mismatch: bigint | number;
    fallback: bigint | number;
  };
  return {
    assignedCount: Number((assigned.toArray()[0] as { n: bigint | number }).n),
    unassignedCount: Number((unassigned.toArray()[0] as { n: bigint | number }).n),
    groupCount: Number((groups.toArray()[0] as { n: bigint | number }).n),
    codeMismatchCount: Number(codeRow.mismatch),
    codeFallbackCount: Number(codeRow.fallback),
    overlayFid: one?.overlayFid ?? null,
    mode: many ? "many" : "one",
  };
}

// Each input feature to its largest-overlap overlay feature (plurality); an optional
// code join wins over that pick wherever it disagrees (docs/adr/0045).
async function assignPerFeature(
  conn: AsyncDuckDBConnection,
  matchColumns: MatchColumnOptions,
): Promise<void> {
  await assignBestOverlap(conn, "input_layer_01", "overlay_layer_01", "ge_pairs", "ge_spatial");

  const resolvedCols = resolveMatchColumns(matchColumns);
  if (resolvedCols) {
    await buildPerInputCodeWinners(conn, {
      inputAttrTable: "input_layer_attr",
      overlayAttrTable: "overlay_layer_attr",
      pairsTable: "ge_pairs",
      pairsInputCol: "a_fid",
      pairsOverlayCol: "b_fid",
      columns: resolvedCols,
      outputTable: "ge_code_winner",
    });
    await combinePerInputAssignment(conn, {
      codeWinnersTable: "ge_code_winner",
      spatialTable: "ge_spatial",
      outputTable: "ge_assignment",
    });
    await conn.query("DROP TABLE IF EXISTS ge_code_winner");
  } else {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ge_assignment AS
      SELECT input_fid, overlay_fid,
             NULL::VARCHAR AS assignment_method, NULL::BOOLEAN AS spatial_agrees
      FROM ge_spatial
    `);
  }
  await conn.query("DROP TABLE IF EXISTS ge_spatial");
  await conn.query("DROP TABLE IF EXISTS ge_pairs");
}
