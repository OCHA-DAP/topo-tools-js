import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "$lib/db/bbox";
import { runDissolveCore } from "$lib/tools/package-polygons/pipeline/dissolveCore";
import {
  detectLevelColumnsOrSingle,
  groupFamiliesByLevel,
  levelFamilyNames,
  verifyFunctionalCluster,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

const EMPTY_LINES = "ST_GeomFromText('MULTILINESTRING EMPTY')";
const RESERVED_COLUMNS = new Set(["left_fid", "right_fid", "geom"]);

async function tableColumnSet(conn: AsyncDuckDBConnection, table: string): Promise<Set<string>> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  return new Set((desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name));
}

// codeColumns[i] is non-null here: resolveFinestGroupBy throws on an empty
// group-by for any level once levels.length > 1.
function classificationSql(levels: number[], codeColumns: Array<string | null>): string {
  if (levels.length === 1) return String(levels[0]);
  const cases = levels
    .slice(0, -1)
    .map((level, i) => `WHEN l."${codeColumns[i]!}" IS DISTINCT FROM r."${codeColumns[i]!}" THEN ${level} `)
    .join("");
  return `CASE ${cases}ELSE ${levels[levels.length - 1]} END`;
}

async function checkEveryFidPresent(
  conn: AsyncDuckDBConnection,
  dissolved: string,
  lines: string,
): Promise<void> {
  const r = await conn.query(`--sql
    SELECT fid FROM "${dissolved}"
    WHERE fid NOT IN (
      SELECT left_fid FROM "${lines}"
      UNION
      SELECT right_fid FROM "${lines}" WHERE right_fid IS NOT NULL
    )
  `);
  const missing = (r.toArray() as Array<{ fid: bigint | number }>).map((row) => Number(row.fid));
  if (missing.length > 0) {
    throw new Error(`${lines}: fid(s) missing from every boundary row: ${missing.join(", ")}`);
  }
}

async function resolveFinestGroupBy(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: number[],
  schema: TargetSchema | null,
): Promise<{
  finestGroupBy: string[];
  codeColumns: Array<string | null>;
  targetSchema: TargetSchema | undefined;
  finestGenerics: Map<string, string | null>;
}> {
  const finest = Math.max(...levels);

  if (schema !== null) {
    const codeColumns = levels.map((n) => schema.codeField.replace("{n}", String(n)));
    const finestGenerics = new Map<string, string | null>([
      ["code", codeColumns[codeColumns.length - 1]],
      ["name", schema.nameField.replace("{n}", String(finest))],
    ]);
    return { finestGroupBy: [codeColumns[codeColumns.length - 1]], codeColumns, targetSchema: schema, finestGenerics };
  }

  const levelColumns = await detectLevelColumnsOrSingle(conn, table);
  const multiLevel = levelColumns.size > 1;
  const safeGroupByByLevel = new Map<number, string[]>();
  for (const n of levels) {
    const cols = levelColumns.get(n)!;
    const identitySet = new Set(cols.identityColumns);
    const safe = cols.groupBy.filter((c) => identitySet.has(c));
    if (safe.length === 0 && multiLevel) {
      throw new Error(`no reliable group-by column detected for level ${n}`);
    }
    safeGroupByByLevel.set(n, safe);
  }
  const codeColumns = levels.map((n) => safeGroupByByLevel.get(n)![0] ?? null);
  const finestGroupBy = safeGroupByByLevel.get(finest)!;
  const finestCode = codeColumns[codeColumns.length - 1];
  if (finestGroupBy.length > 0 && finestCode !== null) {
    await verifyFunctionalCluster(conn, table, finestCode, finestGroupBy);
  }

  const families = await groupFamiliesByLevel(conn, table, levelColumns);
  const renamed = levelFamilyNames(families, finest, finestCode);
  const finestGenerics = new Map<string, string | null>(
    finestGroupBy.map((col) => [renamed.get(col) ?? col, col]),
  );
  return { finestGroupBy, codeColumns, targetSchema: undefined, finestGenerics };
}

export async function buildBoundaries(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  name: string,
  levels: number[],
  schema: TargetSchema | null,
  depthColumn: string,
): Promise<void> {
  if (RESERVED_COLUMNS.has(depthColumn)) {
    throw new Error(`depthColumn "${depthColumn}" collides with a fixed output column`);
  }

  const { finestGroupBy, codeColumns, targetSchema, finestGenerics } = await resolveFinestGroupBy(
    conn,
    tableIn,
    levels,
    schema,
  );

  const dissolved = `${name}_dissolved`;
  await runDissolveCore(conn, tableIn, dissolved, { groupBy: finestGroupBy, targetSchema });

  const dissolvedColumns = await tableColumnSet(conn, dissolved);
  for (const [generic, col] of [...finestGenerics]) {
    if (col === null || !dissolvedColumns.has(col)) finestGenerics.delete(generic);
  }
  if (finestGenerics.size === 0) finestGenerics.set("code", null);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_parts" AS
    SELECT fid, (dump).geom AS geom, ${bboxColumnsSql("(dump).geom")}
    FROM "${dissolved}", UNNEST(ST_Dump(geom)) AS d(dump)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_pairs" AS
    SELECT DISTINCT a.fid AS left_fid, b.fid AS right_fid
    FROM "${name}_parts" a JOIN "${name}_parts" b
      ON a.fid < b.fid
      AND a.xmin <= b.xmax AND a.xmax >= b.xmin
      AND a.ymin <= b.ymax AND a.ymax >= b.ymin
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_boundary" AS
    SELECT fid, ST_Boundary(geom) AS boundary FROM "${dissolved}"
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_boundary_parts" AS
    SELECT fid, (dump).geom AS geom, ${bboxColumnsSql("(dump).geom")}
    FROM "${name}_boundary", UNNEST(ST_Dump(boundary)) AS d(dump)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_touching" AS
    SELECT p.left_fid, p.right_fid
    FROM "${name}_pairs" p
    JOIN "${dissolved}" wl ON wl.fid = p.left_fid
    JOIN "${dissolved}" wr ON wr.fid = p.right_fid
    WHERE ST_Touches(wl.geom, wr.geom)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_shared" AS
    WITH pieces AS (
      SELECT t.left_fid, t.right_fid,
             ST_CollectionExtract(ST_Intersection(lp.geom, rp.geom), 2) AS geom
      FROM "${name}_touching" t
      JOIN "${name}_boundary_parts" lp ON lp.fid = t.left_fid
      JOIN "${name}_boundary_parts" rp ON rp.fid = t.right_fid
        AND lp.xmin <= rp.xmax AND lp.xmax >= rp.xmin
        AND lp.ymin <= rp.ymax AND lp.ymax >= rp.ymin
    ),
    merged AS (
      SELECT left_fid, right_fid, ST_LineMerge(ST_Union_Agg(geom)) AS geom
      FROM pieces
      WHERE NOT ST_IsEmpty(geom)
      GROUP BY left_fid, right_fid
    )
    SELECT left_fid, right_fid, geom FROM merged
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_shared_by_fid" AS
    SELECT fid, ST_Union_Agg(geom) AS geom
    FROM (
      SELECT left_fid AS fid, geom FROM "${name}_shared"
      UNION ALL
      SELECT right_fid AS fid, geom FROM "${name}_shared"
    )
    GROUP BY fid
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_exterior_raw" AS
    SELECT bp.fid,
           ST_LineMerge(ST_Difference(bp.geom, COALESCE(s.geom, ${EMPTY_LINES}))) AS geom
    FROM "${name}_boundary_parts" bp
    LEFT JOIN "${name}_shared_by_fid" s ON s.fid = bp.fid
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_shared_atomic" AS
    SELECT left_fid, right_fid, (dump).geom AS geom
    FROM "${name}_shared", UNNEST(ST_Dump(geom)) AS d(dump)
    WHERE NOT ST_IsEmpty((dump).geom)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_exterior" AS
    SELECT fid AS left_fid, NULL::BIGINT AS right_fid, (dump).geom AS geom
    FROM "${name}_exterior_raw", UNNEST(ST_Dump(geom)) AS d(dump)
    WHERE NOT ST_IsEmpty((dump).geom)
  `);

  const classification = classificationSql(levels, codeColumns);
  const finestEntries = [...finestGenerics];
  const aCols = (table: string) =>
    finestEntries
      .map(([generic, col]) => (col ? `${table}."${col}" AS "a_${generic}"` : `NULL AS "a_${generic}"`))
      .join(", ");
  const sharedBCols = finestEntries
    .map(([generic, col]) => (col ? `r."${col}" AS "b_${generic}"` : `NULL AS "b_${generic}"`))
    .join(", ");
  const exteriorBCols = finestEntries.map(([generic]) => `NULL AS "b_${generic}"`).join(", ");

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}" AS
    SELECT s.left_fid, s.right_fid,
           ${aCols("l")}, ${sharedBCols},
           ${classification} AS "${depthColumn}", s.geom
    FROM "${name}_shared_atomic" s
    JOIN "${dissolved}" l ON l.fid = s.left_fid
    JOIN "${dissolved}" r ON r.fid = s.right_fid

    UNION ALL BY NAME

    SELECT e.left_fid, e.right_fid,
           ${aCols("d")}, ${exteriorBCols},
           ${Math.min(...levels) - 1} AS "${depthColumn}", e.geom
    FROM "${name}_exterior" e
    JOIN "${dissolved}" d ON d.fid = e.left_fid
  `);

  await checkEveryFidPresent(conn, dissolved, name);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}" AS SELECT * EXCLUDE (left_fid, right_fid) FROM "${name}"
  `);

  for (const suffix of [
    "parts",
    "pairs",
    "boundary",
    "boundary_parts",
    "touching",
    "shared",
    "shared_by_fid",
    "exterior_raw",
    "shared_atomic",
    "exterior",
  ]) {
    await conn.query(`DROP TABLE IF EXISTS "${name}_${suffix}"`);
  }
}
