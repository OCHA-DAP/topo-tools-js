import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { canonicalOrder, misorderedSiblings } from "$lib/db/adminColumns";
import { ROW_ORDER_COLUMN } from "$lib/db/export";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import type { CrosswalkRow } from "./crosswalk";

// A null/empty target_column drops that source column; kept columns follow
// crosswalk row order. Geometry lives in layer_01 and is never touched here.
export async function renameColumns(
  conn: AsyncDuckDBConnection,
  crosswalk: CrosswalkRow[],
  schema: TargetSchema,
): Promise<{ sortColumn: string | null; misorderedSiblings: string[] }> {
  const sources = new Map(
    crosswalk.filter((r) => r.targetColumn).map((r) => [r.targetColumn!, r.sourceColumn]),
  );
  const columns = [...sources.keys()];
  const { sortColumn } = canonicalOrder(columns, schema.nameField, schema.codeField);
  const q = (c: string) => JSON.stringify(c);
  const select = columns.map((t) => `, ${q(sources.get(t)!)} AS ${q(t)}`).join("");
  const sortBy = sortColumn ? `${q(sources.get(sortColumn)!)} NULLS LAST, ` : "";
  await conn.query(`
    CREATE OR REPLACE TABLE sr_result_attr AS
    SELECT fid${select}, ROW_NUMBER() OVER (ORDER BY ${sortBy}fid) AS ${ROW_ORDER_COLUMN}
    FROM layer_attr
  `);
  return { sortColumn, misorderedSiblings: misorderedSiblings(columns) };
}
