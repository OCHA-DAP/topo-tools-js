import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { queryToGeoJSON } from "$lib/db/geojson";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { runNameChecks } from "./checks";
import type { NameIssueKind } from "./constants";
import { buildNameUnits, resolveNameLevels, type NameLevel } from "./levels";
import { buildFlagged, buildNameReport, type NameIssueRow } from "./report";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { NameIssueKind, Severity } from "./constants";
export { SEVERITY } from "./constants";
export type { NameIssueRow } from "./report";

export type Bounds = [number, number, number, number];

export interface NameResult {
  issues: NameIssueRow[];
  failed: NameIssueKind[];
  levelCount: number;
  // The flagged units, each feature carrying its report row's `key`.
  flaggedGeoJSON: string;
  rowBounds: Map<string, Bounds>;
}

// Resolves levels over attrTable and runs every check into `${prefix}_02`/`_03`.
export async function scanNames(
  conn: AsyncDuckDBConnection,
  attrTable: string,
  prefix: string,
  schema: TargetSchema | null,
): Promise<{ levels: Map<number, NameLevel>; failed: NameIssueKind[] }> {
  const levels = await resolveNameLevels(conn, attrTable, schema);
  await buildNameUnits(conn, attrTable, prefix, levels);
  const failed = await runNameChecks(conn, prefix);
  return { levels, failed };
}

// Builds `${prefix}_report` and the map highlights from a finished scan.
export async function nameResult(
  conn: AsyncDuckDBConnection,
  prefix: string,
  attrTable: string,
  scan: { levels: Map<number, NameLevel>; failed: NameIssueKind[] },
  fixedSql: string | null,
): Promise<NameResult> {
  const issues = await buildNameReport(conn, prefix, fixedSql);
  await buildFlagged(conn, prefix, attrTable);
  const flaggedGeoJSON = await queryToGeoJSON(
    conn,
    `--sql
    SELECT ST_AsGeoJSON(g.geom) AS _geom, f.key
    FROM ${prefix}_flagged f JOIN layer_01 g USING (fid)
    WHERE g.geom IS NOT NULL
  `,
  );
  const boundsRows = (
    await conn.query(`--sql
      SELECT f.key, MIN(ST_XMin(g.geom)) AS xmin, MIN(ST_YMin(g.geom)) AS ymin,
             MAX(ST_XMax(g.geom)) AS xmax, MAX(ST_YMax(g.geom)) AS ymax
      FROM ${prefix}_flagged f JOIN layer_01 g USING (fid)
      GROUP BY f.key
    `)
  ).toArray() as Array<{ key: string; xmin: number; ymin: number; xmax: number; ymax: number }>;
  const rowBounds = new Map<string, Bounds>(
    boundsRows.map((r) => [r.key, [r.xmin, r.ymin, r.xmax, r.ymax]]),
  );
  return {
    issues,
    failed: scan.failed,
    levelCount: [...scan.levels.values()].filter((l) => l.names.length > 0).length,
    flaggedGeoJSON,
    rowBounds,
  };
}

export async function runNameDetect(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<NameResult> {
  const scan = await scanNames(conn, "layer_attr", "nd", schema);
  return nameResult(conn, "nd", "layer_attr", scan, null);
}
