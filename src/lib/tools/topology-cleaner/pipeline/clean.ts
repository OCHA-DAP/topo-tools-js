import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageCleanInput, runCoverageClean } from "$lib/db/coverageClean";

// The topology-cleaner pipeline. Reads the loader-owned `layer_01` (fid, geom)
// + `layer_attr` tables, then runs DuckDB spatial's ST_CoverageClean over the
// whole coverage via the shared src/lib/db/coverageClean.ts helpers (also used
// by Edge Extender's input-clean gate and merge finalization).

// Build the frozen input list ONCE per load (tc_input). `inputTable` is the
// frozen list to clean (tc_input, or the precision-reduced tc_input_reduced on
// the robustness-retry path).
export async function buildInput(conn: AsyncDuckDBConnection): Promise<number> {
  return buildCoverageCleanInput(conn, "layer_01", "tc_input");
}

// `gapDeg` is already in degrees (see units.ts); 0 = no gap filling.
export async function buildClean(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  gapDeg: number,
  inputTable = "tc_input",
): Promise<void> {
  await runCoverageClean(conn, inputTable, targetTable, { snap: -1, gap: gapDeg });
}

// Precision-reduced copy of layer_01, built lazily for GEOS overlay-robustness
// retries. Real-world coverages sometimes have two adjacent features whose
// shared boundary was digitized/exported independently and differs by float
// jitter (e.g. two vertices ~1e-13 deg apart that were meant to coincide) — GEOS's
// overlay throws TopologyException on this, in both ST_CoverageClean (clean.ts)
// and the gap/overlap detection queries (issues.ts), since none of them
// tolerate near-but-not-exact coincidence.
//
// 1e-10 deg (~10 microns) is the smallest tolerance that reliably resolves this:
// tested against a real failing coverage, 1e-10 gave a stable result identical to
// 1e-9; 1e-11 and 1e-12 still "succeeded" (no thrown exception) but produced a
// DIFFERENT result each time — a sign of running at/below the actual noise floor,
// where the overlay is numerically unstable rather than cleanly resolved. 10
// microns is far below any realistic positional accuracy for administrative
// boundary data, so this only ever collapses jitter, never real shape detail.
const REDUCED_PRECISION_DEG = 1e-10;

// Generic version: reduces precision for any (fid, geom) source table into a
// named target table. layer_01 -> layer_01_reduced is the common case (see
// buildReducedLayer below); the export-verification sweep (verify.ts) reuses
// this directly to make a reduced copy of tc_clean instead.
export async function buildReducedCopy(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    SELECT fid, ST_MakeValid(ST_ReducePrecision(geom, ${REDUCED_PRECISION_DEG})) AS geom
    FROM ${sourceTable}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
}

export async function buildReducedLayer(conn: AsyncDuckDBConnection): Promise<void> {
  await buildReducedCopy(conn, "layer_01", "layer_01_reduced");
}

export async function buildReducedInput(conn: AsyncDuckDBConnection): Promise<void> {
  await buildReducedLayer(conn);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_input_reduced AS
    SELECT
      array_agg(geom ORDER BY fid)::GEOMETRY[] AS geoms,
      array_agg(fid ORDER BY fid)              AS fids
    FROM layer_01_reduced
  `);
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
