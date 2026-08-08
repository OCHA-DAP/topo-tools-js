import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageCleanInput, hasCoverageViolations, runCoverageClean } from "$lib/db/coverageClean";
import { validateCleanOutput } from "./validate";

// The topology-cleaner pipeline. Reads the loader-owned `layer_01` (fid, geom)
// + `layer_attr` tables, then runs DuckDB spatial's ST_CoverageClean over the
// whole coverage via the shared src/lib/db/coverageClean.ts helpers (also used
// by Edge Extender's input-clean gate and merge finalization).

// Build the frozen input list ONCE per load (tc_input).
export async function buildInput(conn: AsyncDuckDBConnection): Promise<number> {
  return buildCoverageCleanInput(conn, "layer_01", "tc_input");
}

// True if layer_01 has any overlaps/unmatched edges. Static per load (layer_01
// never changes), so callers should compute this once and cache it rather
// than re-running it on every reclean — see index.ts's cachedHasViolations.
export async function inputHasViolations(conn: AsyncDuckDBConnection): Promise<boolean> {
  return hasCoverageViolations(conn, "layer_01");
}

// `gapDeg` is already in degrees (see units.ts); 0 = no gap filling.
// `hasViolations` is layer_01's cached inputHasViolations() result: when
// there are no overlaps/unmatched edges AND no gap fill is requested,
// ST_CoverageClean has nothing to do, so skip it entirely and copy layer_01
// straight into targetTable — same gate topo-tools-py's _03_clean.py uses
// (has_coverage_violations() is False and gap_maximum_width_deg is None).
// Matters beyond speed: ST_CoverageClean's WASM-GEOS path has its own
// robustness edges (see gatedCoverageClean's comment in coverageClean.ts) that
// get exercised more, the more it's called on data that didn't need it.
//
// After a real ST_CoverageClean run, validateCleanOutput (pipeline/validate.ts)
// gates the result the same way topo-tools-py's _03_clean.py does — throwing
// rather than accepting an output that's still invalid or has collapsed
// beyond what the detected defects account for. The skip-gate branch above
// never calls it: a straight copy-through can't fail those checks.
//
// ST_CoverageClean writes to a scratch table first, not targetTable directly:
// on rejection, targetTable (tc_clean) must stay whatever it was before this
// call — a reclean that fails validation must not leave the DB-backed export
// sources (GeoParquet/GPKG/etc. dropdown, which query tc_clean directly)
// pointing at rejected output while the UI still shows the last-good result.
export async function buildClean(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  gapDeg: number,
  hasViolations = true,
): Promise<void> {
  if (gapDeg === 0 && !hasViolations) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT fid, geom FROM layer_01 WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    return;
  }
  const scratch = `${targetTable}_scratch`;
  await runCoverageClean(conn, "tc_input", scratch, { snap: -1, gap: gapDeg });
  try {
    await validateCleanOutput(conn, scratch, gapDeg);
  } catch (e) {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
    throw e;
  }
  await conn.query(`CREATE OR REPLACE TABLE ${targetTable} AS SELECT * FROM ${scratch}`);
  await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
}

// Count rows in a cleaned table (post-explode) for the collapsed-feature warning.
export async function countRows(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<number> {
  const r = await conn.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
  );
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}
