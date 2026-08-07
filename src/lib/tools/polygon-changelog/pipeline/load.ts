import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

// cw_a_/cw_b_ prefix = previous/new. Intermediate cw_*_layer_01/layer_attr
// tables persist past this stage: the column-picker UI and table.ts both read them.

export async function loadSide(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  files: File[],
): Promise<void> {
  const prefix = `cw_${side}_`;
  await loadFile(db, conn, files, { prefix });
}

const QIDENT = (s: string) => '"' + s.replace(/"/g, '""') + '"';

export async function buildKeyed(
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  codeCols: string[],
  nameCol: string | null,
): Promise<void> {
  const prefix = `cw_${side}_`;
  const codeExpr =
    codeCols.length === 0
      ? "NULL::VARCHAR"
      : codeCols.length === 1
        ? `CAST(a.${QIDENT(codeCols[0])} AS VARCHAR)`
        : `CONCAT(${codeCols.map((c) => `CAST(a.${QIDENT(c)} AS VARCHAR)`).join(", ")})`;
  const nameExpr = nameCol ? `CAST(a.${QIDENT(nameCol)} AS VARCHAR)` : "NULL::VARCHAR";
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_${side}_keyed AS
    SELECT g.fid AS fid,
           ${codeExpr} AS code,
           ${nameExpr} AS name,
           g.geom AS geom
    FROM ${prefix}layer_01 g
    LEFT JOIN ${prefix}layer_attr a ON a.fid = g.fid
    WHERE g.geom IS NOT NULL
  `);
}

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  // Drop all crosswalk-owned tables from any previous run on the same session
  // so re-running with different inputs starts clean.
  const tables = [
    "cw_a_keyed",
    "cw_b_keyed",
    "cw_a_only",
    "cw_b_only",
    // Scratch tables from the shared overlap module (src/lib/db/overlap.ts),
    // namespaced off the "cw_pairs" output table it's called with.
    "cw_pairs_overlap",
    "cw_pairs_a_areas",
    "cw_pairs_b_areas",
    "cw_pairs_pair_areas",
    "cw_pairs_a_pts",
    "cw_pairs_b_pts",
    "cw_pairs",
    "cw_pairs_classified",
    "cw_polygon_class",
    "cw_changelog",
    "cw_overlay_render",
  ];
  for (const t of tables) await conn.query(`DROP TABLE IF EXISTS ${t}`);
}
