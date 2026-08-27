import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { randomId } from "$lib/db/id";

export interface CrosswalkRow {
  sourceColumn: string;
  targetColumn: string | null;
}

const RAW_TABLE = "sr_crosswalk_raw";

// Plain CSV via native read_csv, bypassing $lib/db/loader.ts's GDAL path.
export async function loadCrosswalkCsv(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  files: File[],
): Promise<void> {
  const file = files[0];
  if (!file) throw new Error("No crosswalk CSV provided.");

  await conn.query(`DROP TABLE IF EXISTS ${RAW_TABLE}`);
  const registeredName = `sr_${randomId()}_${file.name}`;
  const buffer = new Uint8Array(await file.arrayBuffer());
  await db.registerFileBuffer(registeredName, buffer);
  try {
    const sqlPath = "'" + registeredName.replace(/'/g, "''") + "'";
    await conn.query(`
      CREATE OR REPLACE TABLE ${RAW_TABLE} AS
      SELECT * FROM read_csv(${sqlPath}, header = true, all_varchar = true)
    `);
  } finally {
    await db.dropFile(registeredName);
  }
}

// Ports topo-tools-py's _parse_crosswalk.
export async function parseCrosswalk(conn: AsyncDuckDBConnection): Promise<CrosswalkRow[]> {
  const desc = await conn.query(`DESCRIBE ${RAW_TABLE}`);
  const columnNames = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
  if (!columnNames.includes("source_column")) {
    throw new Error("crosswalk must be a CSV with a source_column column.");
  }
  const hasTarget = columnNames.includes("target_column");
  const select = hasTarget ? "source_column, target_column" : "source_column";
  const rows = await conn.query(`SELECT ${select} FROM ${RAW_TABLE}`);
  const all = rows.toArray() as Array<{
    source_column: string | null;
    target_column?: string | null;
  }>;
  const crosswalk = all
    .filter((r) => r.source_column)
    .map((r) => ({
      sourceColumn: r.source_column as string,
      targetColumn: hasTarget ? r.target_column || null : null,
    }));

  const sourceColumns = crosswalk.map((r) => r.sourceColumn);
  const dupes = [...new Set(sourceColumns.filter((c, i) => sourceColumns.indexOf(c) !== i))].sort();
  if (dupes.length > 0) {
    throw new Error(`crosswalk lists the same source_column more than once: ${JSON.stringify(dupes)}`);
  }
  return crosswalk;
}
