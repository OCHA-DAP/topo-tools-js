import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Ported from topo-tools-py's carry_columns: joins the single winning overlay
// feature's own attribute values onto every input_layer_attr row, unprefixed.
export async function carryOverlayColumns(
  conn: AsyncDuckDBConnection,
  columns: string[],
  overlayFid: number,
  inputColumns: string[],
): Promise<void> {
  if (columns.length === 0) return;
  const clashes = columns.filter((c) => inputColumns.includes(c));
  if (clashes.length > 0) {
    throw new Error(`Carried overlay columns already exist on the input layer: ${clashes.join(", ")}`);
  }
  const selectCols = columns.map((c) => `p.${JSON.stringify(c)}`).join(", ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE input_layer_attr AS
    SELECT c.*, ${selectCols}
    FROM input_layer_attr c, (SELECT * FROM overlay_layer_attr WHERE fid = ${overlayFid}) p
  `);
}
