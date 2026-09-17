import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { computeOverlapPairs } from "$lib/db/overlap";
import { quoteIdent } from "$lib/db/code";
import { stageClassify, type ClassifyOptions } from "$lib/tools/polygon-changelog/pipeline/classify";

// Builds cw_{side}_keyed from this level's own dissolved table, so
// stageClassify's fixed table names are reused unmodified per level.
async function buildLevelKeyed(
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  table: string,
  codeColumn: string,
  nameColumn: string | null,
): Promise<void> {
  const nameExpr = nameColumn ? `CAST(${quoteIdent(nameColumn)} AS VARCHAR)` : "NULL::VARCHAR";
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_${side}_keyed AS
    SELECT fid, CAST(${quoteIdent(codeColumn)} AS VARCHAR) AS code, ${nameExpr} AS name, geom
    FROM ${quoteIdent(table)}
    WHERE geom IS NOT NULL
  `);
}

// Writes cw_pairs_classified/cw_polygon_class for level n; assign.ts reads
// them directly before the next level's call overwrites them.
export async function classifyLevel(
  conn: AsyncDuckDBConnection,
  n: number,
  codeColA: string,
  codeColB: string,
  nameColA: string | null,
  nameColB: string | null,
  opts: ClassifyOptions,
): Promise<void> {
  await buildLevelKeyed(conn, "a", `cu_dsl_${n}_a`, codeColA, nameColA);
  await buildLevelKeyed(conn, "b", `cu_dsl_${n}_b`, codeColB, nameColB);
  await computeOverlapPairs(conn, `cu_dsl_${n}_a`, `cu_dsl_${n}_b`, "cw_pairs");
  await stageClassify(conn, opts);
}
