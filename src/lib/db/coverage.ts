import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { NODING_FALLBACK_GRID, SNAP_TOLERANCE } from "./constants";
import { intersectPairs } from "./overlap";
import { degSqToM2, degToM } from "./units";

export async function emptyRegions(
  conn: AsyncDuckDBConnection,
  table: string,
  extra = "",
): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TABLE ${table} AS SELECT NULL::BIGINT AS n${extra}, NULL::GEOMETRY AS geom WHERE FALSE`,
  );
}

function gapHolesSql(targetTable: string, sourceTable: string, geomExpr: string): string {
  return `--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH
    union_cte AS (
      SELECT ST_Union_Agg(${geomExpr}) AS u
      FROM ${sourceTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    ),
    parts AS (
      SELECT (UNNEST(ST_Dump(u))).geom AS poly
      FROM union_cte WHERE u IS NOT NULL
    ),
    holes AS (
      SELECT UNNEST(ST_Dump(
        ST_Difference(ST_MakePolygon(ST_ExteriorRing(poly)), poly)
      )).geom AS geom
      FROM parts WHERE ST_NumInteriorRings(poly) > 0
    )
    SELECT row_number() OVER () AS n, geom
    FROM holes
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `;
}

// Gap regions = interior rings of the union of sourceTable's polygons, written
// to targetTable (n, geom). When the exact union throws, the union is retried
// on a fine grid and a hole whose interior point an input polygon covers is a
// grid artifact, dropped.
export async function buildGapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  try {
    await conn.query(gapHolesSql(targetTable, sourceTable, "geom"));
    return;
  } catch (e) {
    console.warn(`gap union failed; retrying on a ${NODING_FALLBACK_GRID} grid:`, e);
  }
  const holes = `${targetTable}_grid_holes`;
  const source = `${targetTable}_grid_source`;
  try {
    await conn.query(
      gapHolesSql(holes, sourceTable, `ST_ReducePrecision(geom, ${NODING_FALLBACK_GRID})`),
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${source} AS
      SELECT geom, ${bboxColumnsSql()} FROM ${sourceTable}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      WITH pts AS (
        SELECT n, geom, ST_PointOnSurface(geom) AS p FROM ${holes}
      ),
      probes AS (
        SELECT n, p, ST_X(p) AS xmin, ST_X(p) AS xmax, ST_Y(p) AS ymin, ST_Y(p) AS ymax
        FROM pts
      ),
      covered AS (
        SELECT DISTINCT h.n FROM probes h JOIN ${source} s
          ON ${bboxOverlapSql("h", "s")} AND ST_Intersects(s.geom, h.p)
      )
      SELECT row_number() OVER (ORDER BY n) AS n, geom
      FROM pts WHERE n NOT IN (SELECT n FROM covered)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${holes}`);
    await conn.query(`DROP TABLE IF EXISTS ${source}`);
  }
}

// True if sourceTable's coverage has an interior hole at or below maxWidth
// (degrees) — mirrors topo-tools-py's has_gaps(gap_maximum_width=...).
// sourceTable is expected to already have been cleaned with a matching
// gap-fill width, so a hole this small surviving means the fill silently
// failed; a wider hole may be a legitimate feature (see docs/adr/0028) and
// isn't flagged by this check.
export async function hasNoiseFloorGap(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  maxWidth: number = SNAP_TOLERANCE,
): Promise<boolean> {
  const scratch = `${sourceTable}_noise_gap_check`;
  try {
    await buildGapTable(conn, scratch, sourceTable);
    const r = await conn.query(`--sql
      SELECT EXISTS (
        SELECT 1 FROM ${scratch}
        WHERE (ST_MaximumInscribedCircle(geom)).radius * 2 <= ${maxWidth}
      ) AS bad
    `);
    return Boolean(r.toArray()[0].bad);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
  }
}

export const MICRO_MERGED_REASON = "merged into neighbouring feature";
export const MICRO_DROPPED_REASON = "dropped: touches no feature";

// Ported from topo-tools-py's is_micro_sql: 2*area/perimeter bounds the
// inscribed-circle diameter from below, so CASE skips it for every wide part.
export function isMicroSql(geom: string, width: number = SNAP_TOLERANCE): string {
  return (
    `CASE WHEN ST_IsEmpty(${geom}) THEN FALSE ` +
    `WHEN 2 * ST_Area(${geom}) <= ${width} * ST_Perimeter(${geom}) ` +
    `THEN (ST_MaximumInscribedCircle(${geom})).radius * 2 <= ${width} ` +
    "ELSE FALSE END"
  );
}

export async function hasMicroPolygons(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<boolean> {
  const r = await conn.query(`--sql
    SELECT EXISTS (
      SELECT 1 FROM (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM ${table}
                     WHERE geom IS NOT NULL)
      WHERE ${isMicroSql("geom")}
    ) AS bad
  `);
  return Boolean(r.toArray()[0].bad);
}

async function emptyMicroIssues(conn: AsyncDuckDBConnection, issuesTable: string): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT NULL::VARCHAR AS key, NULL::VARCHAR AS kind, NULL::BIGINT AS unit_a,
           NULL::BIGINT AS unit_b, NULL::VARCHAR AS reason, NULL::DOUBLE AS area_m2,
           NULL::DOUBLE AS max_width_m, NULL::BOOLEAN AS fixed, NULL::GEOMETRY AS geom,
           NULL::DOUBLE AS xmin, NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymin, NULL::DOUBLE AS ymax
    WHERE FALSE
  `);
}

// Per-row rebuild of `rebuilt` after the set-based union throws: a row that still
// throws is retried with its own parts snapped onto the incoming micro parts.
async function rebuildRowwise(
  conn: AsyncDuckDBConnection,
  parts: string,
  dest: string,
  touched: string,
  rebuilt: string,
): Promise<number> {
  const rnids = (await conn.query(`SELECT rnid FROM ${touched}`)).toArray() as Array<{
    rnid: bigint | number;
  }>;
  await conn.query(`CREATE OR REPLACE TABLE ${rebuilt} (rnid BIGINT, geom GEOMETRY)`);
  let snapped = 0;
  for (const { rnid } of rnids) {
    const insert = (combine: string) => `--sql
      INSERT INTO ${rebuilt}
      WITH own AS (SELECT ST_Union_Agg(geom) AS g FROM ${parts} WHERE rnid = ${rnid} AND NOT micro),
      incoming AS (SELECT ST_Union_Agg(geom) AS g FROM ${dest} WHERE dest_rnid = ${rnid})
      SELECT * FROM (SELECT ${rnid}, ${combine} AS geom FROM own, incoming)
      WHERE NOT ST_IsEmpty(geom)
    `;
    try {
      await conn.query(insert("COALESCE(ST_Union(own.g, incoming.g), own.g, incoming.g)"));
    } catch {
      await conn.query(
        insert(`ST_Union(ST_Snap(own.g, incoming.g, ${SNAP_TOLERANCE}), incoming.g)`),
      );
      snapped++;
    }
  }
  return snapped;
}

// Ported from topo-tools-py's merge_micro_polygons, which holds the merge rule;
// writes one micro-polygon row per part to issuesTable and returns the count.
export async function mergeMicroPolygons(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  issuesTable: string,
): Promise<number> {
  if (!(await hasMicroPolygons(conn, tableIn))) {
    await emptyMicroIssues(conn, issuesTable);
    if (tableOut !== tableIn) {
      await conn.query(`CREATE OR REPLACE TABLE ${tableOut} AS SELECT * FROM ${tableIn}`);
    }
    return 0;
  }
  const tol = SNAP_TOLERANCE;
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  const all = `${issuesTable}_all`;
  const parts = `${issuesTable}_parts`;
  const dest = `${issuesTable}_dest`;
  const touched = `${issuesTable}_touched`;
  const rebuilt = `${issuesTable}_rebuilt`;
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE ${all} AS SELECT row_number() OVER () AS rnid, * FROM ${tableIn}`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${parts} AS
      WITH p AS (
        SELECT rnid, fid, UNNEST(ST_Dump(geom)).geom AS geom FROM ${all} WHERE geom IS NOT NULL
      )
      SELECT row_number() OVER () AS pid, *, ${isMicroSql("geom")} AS micro, ${bboxColumnsSql()}
      FROM p
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${dest} AS
      WITH m AS (SELECT * FROM ${parts} WHERE micro),
      n AS (SELECT * FROM ${parts} WHERE NOT micro),
      pairs AS (
        SELECT m.pid, n.rnid AS dest_rnid, n.fid AS dest_fid,
               ST_Area(ST_Intersection(ST_Buffer(m.geom, ${tol}), n.geom)) AS w
        FROM m JOIN n
          ON n.xmin <= m.xmax + ${tol} AND n.xmax >= m.xmin - ${tol}
         AND n.ymin <= m.ymax + ${tol} AND n.ymax >= m.ymin - ${tol}
      )
      SELECT m.pid, m.rnid, m.fid, m.geom, p.dest_rnid, p.dest_fid
      FROM m LEFT JOIN (
        SELECT * FROM pairs WHERE w > 0
        QUALIFY row_number() OVER (PARTITION BY pid ORDER BY w DESC, dest_fid) = 1
      ) p USING (pid)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${issuesTable} AS
      SELECT 'micro-polygon-' || pid AS key, 'micro-polygon' AS kind,
             fid AS unit_a, dest_fid AS unit_b,
             CASE WHEN dest_rnid IS NULL THEN '${MICRO_DROPPED_REASON}'
                  ELSE '${MICRO_MERGED_REASON}' END AS reason,
             ST_Area(geom) * ${areaFactor} AS area_m2,
             (ST_MaximumInscribedCircle(geom)).radius * 2 * ${widthFactor} AS max_width_m,
             TRUE AS fixed, geom, ${bboxColumnsSql()}
      FROM ${dest}
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${touched} AS
      SELECT rnid FROM ${dest}
      UNION SELECT dest_rnid FROM ${dest} WHERE dest_rnid IS NOT NULL
    `);
    try {
      await conn.query(`--sql
        CREATE OR REPLACE TABLE ${rebuilt} AS
        WITH pieces AS (
          SELECT p.rnid, p.geom FROM ${parts} p SEMI JOIN ${touched} USING (rnid) WHERE NOT p.micro
          UNION ALL
          SELECT dest_rnid, geom FROM ${dest} WHERE dest_rnid IS NOT NULL
        )
        SELECT rnid, ST_Union_Agg(geom) AS geom FROM pieces GROUP BY rnid
      `);
    } catch {
      // WASM GEOS throws "non-noded intersection" on some near-coincident edges.
      const snapped = await rebuildRowwise(conn, parts, dest, touched, rebuilt);
      if (snapped > 0) console.warn(`mergeMicroPolygons: ${snapped} row(s) unioned after snapping`);
    }
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${tableOut} AS
      SELECT t.* EXCLUDE (geom, rnid), COALESCE(r.geom, t.geom) AS geom
      FROM ${all} t LEFT JOIN ${rebuilt} r USING (rnid)
      WHERE r.rnid IS NOT NULL OR t.rnid NOT IN (SELECT rnid FROM ${touched})
    `);
    const r = await conn.query(`SELECT COUNT(*) AS n FROM ${issuesTable}`);
    const count = Number((r.toArray()[0] as { n: bigint | number }).n);
    console.log(`merged or dropped ${count} micro-polygon part(s) in ${tableIn}`);
    return count;
  } finally {
    for (const t of [all, parts, dest, touched, rebuilt])
      await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

// Ported from topo-tools-py's check_no_erosion; hard error, since a footprint
// shrunk by extend/merge is data loss, not a cosmetic topology defect.
export async function checkNoErosion(
  conn: AsyncDuckDBConnection,
  tableBefore: string,
  tableAfter: string,
  buffer: number = SNAP_TOLERANCE,
): Promise<void> {
  const r = await conn.query(`--sql
    SELECT b.fid AS fid
    FROM ${tableBefore} b
    LEFT JOIN ${tableAfter} a USING (fid)
    WHERE a.geom IS NULL OR NOT ST_Covers(ST_Buffer(a.geom, ${buffer}), b.geom)
  `);
  const rows = r.toArray() as Array<{ fid: bigint | number }>;
  if (rows.length > 0) {
    const fids = rows.map((row) => Number(row.fid));
    const shown = fids.slice(0, 20).join(", ");
    const suffix = fids.length > 20 ? ", ..." : "";
    throw new Error(
      `extension eroded the original footprint of ${fids.length} fid(s): ${shown}${suffix}`,
    );
  }
}

// Overlap regions = polygonal pairwise intersections of sourceTable's polygons,
// written to targetTable (n, fa, fb, geom). ST_Overlaps/ST_Contains, not
// ST_Intersects, which would also match every ordinary touching-edge pair.
export async function buildOverlapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  const bboxed = `${targetTable}_bbox`;
  const pieces = `${targetTable}_pieces`;
  await conn.query(
    `CREATE OR REPLACE TABLE ${bboxed} AS SELECT fid AS id, geom, ${bboxColumnsSql()} FROM ${sourceTable}`,
  );
  try {
    await intersectPairs(
      conn,
      "buildOverlapTable",
      bboxed,
      bboxed,
      pieces,
      `a.id < b.id AND (ST_Overlaps(a.geom, b.geom) OR ST_Contains(a.geom, b.geom) OR ST_Contains(b.geom, a.geom))`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT row_number() OVER () AS n, a_id AS fa, b_id AS fb, geom
      FROM ${pieces}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${bboxed}`);
    await conn.query(`DROP TABLE IF EXISTS ${pieces}`);
  }
}
