import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { withNodingRetry } from "$lib/db/precisionRetry";

// One dissolve attempt at a given candidate precision. `reduceOriginalToo`
// controls whether ST_ReducePrecision is also applied to the untouched real
// input row (layer_01), not just the derived Voronoi remainder — see the
// tiering note in stageMerge below for why this is a fallback, not the
// default.
async function attemptDissolve(
  conn: AsyncDuckDBConnection,
  precision: number,
  reduceOriginalToo: boolean,
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_04 AS
    SELECT fid, ST_MakeValid(ST_ReducePrecision(geom, ${precision})) AS geom
    FROM layer_04_orig
  `);

  // Original rows, UNION ALL each fid's non-empty Voronoi-cell remainder
  // (the cell minus everything already covered by a nearby original
  // polygon). A single ST_Union_Agg(layer_01) as one global blob used as
  // a per-fid ST_Difference operand OOMs at large scale —
  // bbox-prefiltered self-join per cell against nearby parts only, same
  // pattern lines.ts uses for its neighbor-union join. `is_derived` marks
  // which rows came from the Voronoi side vs. the real input, so the final
  // dissolve below can choose which side(s) to reduce.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp2 AS
    WITH
    v AS (
      SELECT fid, geom,
        ST_XMin(geom) AS xmin, ST_XMax(geom) AS xmax,
        ST_YMin(geom) AS ymin, ST_YMax(geom) AS ymax
      FROM layer_04
    ),
    neighbor_union AS (
      SELECT v.fid AS vfid, ST_Union_Agg(p.part_geom) AS geom
      FROM v
      JOIN layer_05_tmp1 p
        ON p.xmax >= v.xmin AND p.xmin <= v.xmax
       AND p.ymax >= v.ymin AND p.ymin <= v.ymax
      GROUP BY v.fid
    ),
    remainder AS (
      SELECT v.fid,
        ST_MakeValid(ST_CollectionExtract(
          CASE WHEN n.geom IS NOT NULL
               THEN ST_Difference(v.geom, n.geom)
               ELSE v.geom
          END, 3
        )) AS geom
      FROM v
      LEFT JOIN neighbor_union n ON v.fid = n.vfid
    )
    SELECT fid, geom, FALSE AS is_derived FROM layer_01
    UNION ALL
    SELECT fid, geom, TRUE AS is_derived FROM remainder WHERE NOT ST_IsEmpty(geom)
  `);

  // Dissolve original + extension pieces to one row per fid via a direct
  // polygon union. A boundary+node+ST_BuildArea reconstruction was tried
  // here instead (see docs/wasm-geos-noding-investigation.md, fix #5) to
  // work around the noding crash, but ST_BuildArea infers solid-vs-hole
  // from ring nesting, and on real data that classification can invert:
  // confirmed on real input (Gobernadora/Montijo group) where the
  // reconstruction turned ~99.6% of a real polygon's own area into a
  // spurious interior hole. The precision retry above, not the dissolve
  // algorithm, is what actually eliminates the noding crash, so there is
  // no correctness/robustness tradeoff in reverting to direct union.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05 AS
    SELECT fid, ST_Union_Agg(
      CASE WHEN is_derived OR ${reduceOriginalToo}
           THEN ST_ReducePrecision(geom, ${precision})
           ELSE geom
      END
    ) AS geom
    FROM layer_05_tmp2
    GROUP BY fid
  `);
}

export async function stageMerge(conn: AsyncDuckDBConnection): Promise<void> {
  // Per-part layer_01 with bbox columns. Parts (not whole multi-part fids) keep
  // the bbox tight — a fid spanning mainland to a remote island would otherwise
  // make a whole-fid bbox match nearly everything nearby.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp1 AS
    WITH parts AS (
      SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM layer_01
    )
    SELECT fid, part_geom,
      ST_XMin(part_geom) AS xmin, ST_XMax(part_geom) AS xmax,
      ST_YMin(part_geom) AS ymin, ST_YMax(part_geom) AS ymax
    FROM parts
  `);

  // Preserve the pristine Voronoi output — each retry attempt below reduces
  // precision from this same pristine base, never compounding across
  // attempts.
  await conn.query("CREATE OR REPLACE TABLE layer_04_orig AS SELECT * FROM layer_04");

  // Tiered retry: first sweep all 28 candidates reducing only the derived
  // Voronoi remainder, never the real input (layer_01) — the cheaper,
  // preferred path, sufficient for the vast majority of cases. Only if that
  // entire sweep is exhausted do we escalate to a second sweep that also
  // reduces the real-input row. This is needed because reducing only the
  // derived side can still fail: the untouched original polygon's
  // full-float64 boundary vertices don't land on the same rounding grid as
  // the now-snapped remainder, so GEOS can see them as a near-miss crossing
  // instead of a proper touch. Confirmed on real data (Santa Isabel, PAN
  // adm2 fid 14, in a whole-dataset 76-feature merge): derived-only exhausted
  // all 28 candidates, but reducing both sides fixed it at every candidate
  // tried, down to the finest (0.1mm) — negligible cost against a real
  // polygon boundary, and applied only to this transient union input, never
  // persisted back onto real data.
  try {
    await withNodingRetry((precision) => attemptDissolve(conn, precision, false));
  } catch (derivedOnlyError) {
    console.warn(
      "stageMerge: all derived-only precision attempts failed, escalating to reduce the real input too:",
      derivedOnlyError,
    );
    await withNodingRetry((precision) => attemptDissolve(conn, precision, true));
  }

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_04_orig");
  await conn.query("DROP TABLE IF EXISTS layer_04");
  await conn.query("DROP TABLE IF EXISTS layer_05_tmp2");
}
