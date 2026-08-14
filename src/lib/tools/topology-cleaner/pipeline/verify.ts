import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { gapRegionsQuery, overlapRegionsQuery } from "$lib/db/coverage";

export interface ExportCheck {
  rowCount: number;
  invalidCount: number;
  residualGaps: number;
  residualOverlaps: number;
  // True if a sweep below couldn't complete — an UNVERIFIABLE export,
  // distinct from a verified-clean one (0 everywhere with checkFailed false).
  checkFailed: boolean;
}

async function countRegions(
  conn: AsyncDuckDBConnection,
  queryFn: (target: string, source: string) => string,
  scratchTable: string,
): Promise<{ count: number; failed: boolean }> {
  try {
    await conn.query(queryFn(scratchTable, "tc_clean"));
  } catch (e) {
    console.warn(`export check: ${scratchTable} failed:`, e);
    return { count: 0, failed: true };
  }
  const r = await conn.query(
    `SELECT COUNT(*) AS n FROM ${scratchTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
  );
  return { count: Number((r.toArray()[0] as { n: bigint | number }).n ?? 0), failed: false };
}

// Validates the EXACT table that gets exported (tc_clean) — independent of
// which original-input issues it was meant to fix. Catches anything the clean
// itself might have introduced. Reuses the same gap/overlap query builders as
// the input-side detection ($lib/db/coverage), just pointed at tc_clean
// instead of layer_01.
export async function verifyExport(conn: AsyncDuckDBConnection): Promise<ExportCheck> {
  const rowRes = await conn.query(
    "SELECT COUNT(*) AS n FROM tc_clean WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)",
  );
  const rowCount = Number((rowRes.toArray()[0] as { n: bigint | number }).n ?? 0);

  let invalidCount = 0;
  let invalidCheckFailed = false;
  try {
    const r = await conn.query(
      "SELECT COUNT(*) AS n FROM tc_clean WHERE geom IS NOT NULL AND NOT ST_IsValid(geom)",
    );
    invalidCount = Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
  } catch (e) {
    console.warn("export check: ST_IsValid sweep failed:", e);
    invalidCheckFailed = true;
  }

  const gaps = await countRegions(conn, gapRegionsQuery, "tc_verify_gaps");
  const overlaps = await countRegions(conn, overlapRegionsQuery, "tc_verify_overlaps");

  return {
    rowCount,
    invalidCount,
    residualGaps: gaps.count,
    residualOverlaps: overlaps.count,
    checkFailed: invalidCheckFailed || gaps.failed || overlaps.failed,
  };
}
