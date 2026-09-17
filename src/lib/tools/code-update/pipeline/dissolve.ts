import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { runDissolveCore } from "$lib/tools/package-polygons/pipeline/dissolveCore";
import type { SideLevels } from "./levels";

// Dissolves one side's finest table into dest, grouped by level's own column.
async function dissolveSide(
  conn: AsyncDuckDBConnection,
  table: string,
  dest: string,
  level: number,
  side: SideLevels,
): Promise<void> {
  if (side.schema !== null) {
    await runDissolveCore(conn, table, dest, {
      groupBy: [side.schema.codeField.replace("{n}", String(level))],
      targetSchema: side.schema,
    });
    return;
  }

  const cluster = side.levelColumns!.get(level)!;
  const exclude: string[] = [];
  for (const [lvl, cols] of side.levelColumns!) {
    if (lvl > level) exclude.push(...cols.identityColumns);
  }
  await runDissolveCore(conn, table, dest, { groupBy: cluster.groupBy, exclude });
}

// Dissolves `cu_dsl_{n}_a`/`_b` for level n.
export async function dissolveLevel(
  conn: AsyncDuckDBConnection,
  oldTable: string,
  newTable: string,
  n: number,
  sideA: SideLevels,
  sideB: SideLevels,
): Promise<void> {
  await dissolveSide(conn, oldTable, `cu_dsl_${n}_a`, n, sideA);
  await dissolveSide(conn, newTable, `cu_dsl_${n}_b`, n, sideB);
}
