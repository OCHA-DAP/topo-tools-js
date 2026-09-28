import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { canonicalOrder } from "$lib/db/adminColumns";
import { ROW_ORDER_COLUMN } from "$lib/db/export";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import type { CrosswalkRow } from "./crosswalk";

// A null/empty target_column drops that source column; geometry lives in
// layer_01 and is never touched here. Returns the row sort column, if any.
export async function renameColumns(
  conn: AsyncDuckDBConnection,
  crosswalk: CrosswalkRow[],
  schema: TargetSchema,
): Promise<string | null> {
  const sources = new Map(
    crosswalk.filter((r) => r.targetColumn).map((r) => [r.targetColumn!, r.sourceColumn]),
  );
  const { ordered, sortColumn } = canonicalOrder(
    [...sources.keys()],
    schema.nameField,
    schema.codeField,
  );
  const q = (c: string) => JSON.stringify(c);
  const select = ordered.map((t) => `, ${q(sources.get(t)!)} AS ${q(t)}`).join("");
  const sortBy = sortColumn ? `${q(sources.get(sortColumn)!)} NULLS LAST, ` : "";
  await conn.query(`
    CREATE OR REPLACE TABLE sr_result_attr AS
    SELECT fid${select}, ROW_NUMBER() OVER (ORDER BY ${sortBy}fid) AS ${ROW_ORDER_COLUMN}
    FROM layer_attr
  `);
  return sortColumn;
}
