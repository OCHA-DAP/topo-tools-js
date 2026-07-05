import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Shared ST_CoverageClean plumbing used by both the Topology Cleaner tool
// (topology-cleaner/pipeline/clean.ts) and Edge Extender's input-clean gate and
// merge finalization. ST_CoverageClean takes a GEOMETRY[] and returns a
// GeometryCollection in the SAME order as the input list, so every caller here
// follows the same shape: freeze an (fid, geom) table into an ORDER BY fid
// array once, then explode the cleaned result back to one row per fid by the
// top-level dump-path index.

// DuckDB accepts scientific notation in numeric literals, but format defensively.
function fmt(n: number): string {
  return Number.isFinite(n) ? n.toString() : "-1";
}

export interface CoverageCleanOptions {
  // GEOS snapping tolerance; -1 = auto (GEOS computes dataset_diameter / 1e8,
  // which absorbs float jitter without needing an explicit value).
  snap?: number;
  // gap_max_width, in the same units as geom (degrees, post-normalization);
  // 0 = no gap filling.
  gap?: number;
}

// Freezes an (fid, geom) source table into a single-row (geoms[], fids[]) array
// table, ordered by fid so geoms[i] <-> fids[i] holds — load-bearing since
// preserve_insertion_order=false is set globally. Returns the row count (array
// length) so callers can detect an empty/all-null input before cleaning.
export async function buildCoverageCleanInput(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
): Promise<number> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    SELECT
      array_agg(geom ORDER BY fid)::GEOMETRY[] AS geoms,
      array_agg(fid  ORDER BY fid)             AS fids
    FROM ${sourceTable}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const r = await conn.query(`SELECT COALESCE(len(fids), 0) AS n FROM ${targetTable}`);
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}

// Runs ST_CoverageClean over a table already frozen by buildCoverageCleanInput
// and explodes the result back to one row per surviving fid. We key on the
// top-level dump path index (s.path[1], 1-based) to recover fid, regrouping a
// cleaned MultiPolygon element's parts (e.g. [2,1],[2,2]) back to one fid with
// a per-element (tiny) ST_Union_Agg — never a global union. ST_Dump drops EMPTY
// elements, so collapsed polygons simply don't appear in the output (callers
// derive a collapsed count from the row delta if they need it).
export async function runCoverageClean(
  conn: AsyncDuckDBConnection,
  inputTable: string,
  targetTable: string,
  { snap = -1, gap = 0 }: CoverageCleanOptions = {},
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH cleaned AS (
      SELECT fids, ST_CoverageClean(geoms, ${fmt(snap)}, ${fmt(gap)}) AS coll
      FROM ${inputTable}
    ),
    dumped AS (
      SELECT fids, UNNEST(ST_Dump(coll)) AS s FROM cleaned
    )
    SELECT fids[s.path[1]] AS fid, ST_MakeValid(ST_Union_Agg(s.geom)) AS geom
    FROM dumped
    GROUP BY fids[s.path[1]]
  `);
}

// One-shot convenience wrapper for callers that don't need to reuse the frozen
// input array across a retry (e.g. Topology Cleaner's precision-reduction
// retry path reuses buildCoverageCleanInput/runCoverageClean directly instead).
//
// preserveOriginal: true falls back to sourceTable's own (pre-clean) geometry
// for any fid ST_CoverageClean collapses to EMPTY, instead of dropping the row
// (Edge Extender's contract — a merge/input-clean step must never change the
// fid set, since downstream stages assume it's stable). Topology Cleaner wants
// the opposite (collapsed rows should disappear so it can report a collapse
// count), so it leaves this off.
export async function buildCoverageClean(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
  opts: CoverageCleanOptions & { preserveOriginal?: boolean } = {},
): Promise<void> {
  const { preserveOriginal, ...cleanOpts } = opts;
  const scratchInput = `${targetTable}_cc_input`;
  await buildCoverageCleanInput(conn, sourceTable, scratchInput);

  if (!preserveOriginal) {
    await runCoverageClean(conn, scratchInput, targetTable, cleanOpts);
    await conn.query(`DROP TABLE IF EXISTS ${scratchInput}`);
    return;
  }

  const scratchClean = `${targetTable}_cc_clean`;
  await runCoverageClean(conn, scratchInput, scratchClean, cleanOpts);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    SELECT s.fid, COALESCE(c.geom, s.geom) AS geom
    FROM ${sourceTable} s
    LEFT JOIN ${scratchClean} c USING (fid)
  `);
  await conn.query(`DROP TABLE IF EXISTS ${scratchInput}`);
  await conn.query(`DROP TABLE IF EXISTS ${scratchClean}`);
}
