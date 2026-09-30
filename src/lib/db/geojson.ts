import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Shared GeoJSON serialization. ST_AsGeoJSON emits each geometry as a JSON
// string, which we splice in raw — this avoids GDAL driver type/geometry
// incompatibilities that the streaming export path would otherwise hit, and
// it's the same approach the edge-extend and topo-clean pipelines use
// to hand results to MapLibre.
//
// When `attrTable` is null the features carry empty properties (geometry-only
// layers: original input, highlights). When set, attributes are LEFT JOINed on
// `fid`, with types DuckDB/JSON can't represent cast to VARCHAR.

const isIncompatible = (t: string): boolean =>
  t === "BLOB" ||
  t === "HUGEINT" ||
  t === "UHUGEINT" ||
  t.startsWith("STRUCT") ||
  t.startsWith("MAP") ||
  t.includes("[]");

export async function tableToGeoJSON(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  attrTable: string | null,
): Promise<string> {
  if (!attrTable) {
    const rows = await conn.query(`--sql
      SELECT ST_AsGeoJSON(geom) AS _geom
      FROM ${sourceTable}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    const features = (rows.toArray() as Array<{ _geom: string }>).map((row) => ({
      type: "Feature",
      geometry: JSON.parse(row._geom),
      properties: {},
    }));
    return JSON.stringify({ type: "FeatureCollection", features });
  }

  const attrDesc = await conn.query(`DESCRIBE ${attrTable}`);
  const attrSchema = attrDesc.toArray() as Array<{
    column_name: string;
    column_type: string;
  }>;
  const propKeys = attrSchema.filter((r) => r.column_name !== "fid").map((r) => r.column_name);
  const attrExprs = attrSchema
    .filter((r) => r.column_name !== "fid")
    .map((r) => {
      const col = JSON.stringify(r.column_name);
      return isIncompatible(r.column_type) ? `CAST(b.${col} AS VARCHAR) AS ${col}` : `b.${col}`;
    });
  const selectCols = attrExprs.length > 0 ? ", " + attrExprs.join(", ") : "";

  const rows = await conn.query(`--sql
    SELECT ST_AsGeoJSON(a.geom) AS _geom${selectCols}
    FROM ${sourceTable} AS a
    LEFT JOIN ${attrTable} AS b ON a.fid = b.fid
    WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom)
  `);

  const features = (rows.toArray() as Array<Record<string, unknown>>).map((row) => {
    const props: Record<string, unknown> = {};
    for (const k of propKeys) props[k] = row[k];
    return {
      type: "Feature",
      geometry: JSON.parse(row._geom as string),
      properties: props,
    };
  });
  return JSON.stringify({ type: "FeatureCollection", features }, (_, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
}
