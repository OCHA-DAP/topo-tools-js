import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { DuckDBDataProtocol } from "@duckdb/duckdb-wasm";
import { zip as fflateZip } from "fflate";
import { duckdbState } from "./duckdb.svelte";

export type ExportSource =
  | "extend"
  | "clean_topology"
  | "topology_issues"
  | "crosswalk_overlay"
  | "crosswalk_changelog"
  | "match"
  | "match_issues"
  | "stitch"
  | "stitch_issues"
  | "detect_issues"
  | "clip"
  | "mosaic"
  | "mosaic_issues";

export type ExportKind = "geojson_cached" | "gdal" | "parquet" | "csv";

export type SourceKind = "spatial" | "tabular";

export interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  mime: string;
  kind: ExportKind;
  driver?: string;
  rank: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

interface DriverMeta {
  label: string;
  ext: string;
  mime: string;
  rank: number;
  layerOptions?: string[];
}

// Curated set of GDAL output drivers under DuckDB-WASM's spatial extension.
// All route through a registered OPFS FileSystemFileHandle (see exportGdal) —
// duckdb-wasm's plain BUFFER filesystem silently produces 1-byte placeholder
// files instead of erroring. GeoJSON and GPX are excluded (served from the
// cached string, and polygon-incompatible, respectively); KML/LIBKML both
// produce .kml, so we surface whichever the loaded build provides.
const KNOWN_DRIVERS: Record<string, DriverMeta> = {
  GPKG: {
    label: "GeoPackage (.gpkg)",
    ext: ".gpkg",
    mime: "application/geopackage+sqlite3",
    rank: 20,
  },
  "ESRI Shapefile": {
    label: "Shapefile (.shp.zip)",
    ext: ".shp.zip",
    mime: "application/zip",
    rank: 30,
    // ENCODING=UTF-8 makes GDAL write the .cpg sidecar declaring UTF-8 and
    // ensures non-ASCII attribute values round-trip through the .dbf.
    layerOptions: ["ENCODING=UTF-8"],
  },
  // FGB writes a spatial index by default; the back-patched header needs
  // random-write semantics, same precedent as Shapefile.
  FlatGeobuf: {
    label: "FlatGeobuf (.fgb)",
    ext: ".fgb",
    mime: "application/vnd.flatgeobuf",
    rank: 40,
  },
  // LIBKML is preferred over KML when the build provides it: the older KML
  // driver writes a minimal <Style> with only <LineStyle>, which QGIS honours
  // by drawing just polygon outlines. LIBKML writes a complete style block.
  // Iteration order matters because both share the same label and the
  // pushUnique de-dup keeps the first one seen.
  LIBKML: {
    label: "KML (.kml)",
    ext: ".kml",
    mime: "application/vnd.google-earth.kml+xml",
    rank: 50,
  },
  KML: {
    label: "KML (.kml)",
    ext: ".kml",
    mime: "application/vnd.google-earth.kml+xml",
    rank: 50,
  },
  GML: {
    label: "GML (.gml)",
    ext: ".gml",
    mime: "application/gml+xml",
    rank: 60,
  },
};

interface SourceConfig {
  table: string;
  attrTable: string | null;
  suffix: string;
  kind: SourceKind;
  // Explicit attribute column allowlist for attrTable === null sources. When
  // unset, buildSpatialSelect passes through every non-geom column from the
  // table (DESCRIBE-based). Use this when the table carries internal columns
  // (e.g. raw-degree measurements, bounding boxes) that shouldn't leak into
  // the exported attribute table.
  columns?: string[];
}

const SOURCES: Record<ExportSource, SourceConfig> = {
  extend: { table: "layer_05", attrTable: "layer_attr", suffix: "_ee", kind: "spatial" },
  clean_topology: { table: "tc_clean", attrTable: "layer_attr", suffix: "_cleaned", kind: "spatial" },
  topology_issues: {
    table: "tc_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "fixed",
      "unit_a",
      "unit_b",
      "unit_a_area_change_m2",
      "unit_b_area_change_m2",
      "filled_area_m2",
    ],
  },
  crosswalk_overlay: {
    table: "cw_overlay_render",
    attrTable: null,
    suffix: "_cw_overlay",
    kind: "spatial",
  },
  crosswalk_changelog: {
    table: "cw_changelog",
    attrTable: null,
    suffix: "_changelog",
    kind: "tabular",
  },
  match: {
    table: "ge_results",
    attrTable: "ge_results_attr",
    suffix: "_matched",
    kind: "spatial",
  },
  match_issues: {
    table: "ge_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: ["key", "kind", "child_fid", "parent_fid", "reason"],
  },
  stitch: { table: "st_clean", attrTable: "layer_attr", suffix: "_stitched", kind: "spatial" },
  stitch_issues: {
    table: "st_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: ["key", "kind", "area_m2", "max_width_m", "thinness_ratio", "fixed", "unit_a", "unit_b"],
  },
  detect_issues: {
    table: "dt_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: ["key", "kind", "area_m2", "max_width_m", "thinness_ratio", "unit_a", "unit_b"],
  },
  clip: { table: "cl_clip", attrTable: "child_layer_attr", suffix: "_clipped", kind: "spatial" },
  mosaic: { table: "st_clean", attrTable: "child_layer_attr", suffix: "_mosaicked", kind: "spatial" },
  mosaic_issues: {
    table: "ms_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: ["key", "kind", "area_m2", "max_width_m", "thinness_ratio", "unit_a"],
  },
};

export function sourceKind(source: ExportSource): SourceKind {
  return SOURCES[source].kind;
}

// GDAL-driven GeoJSON. Used as the primary-button format when DownloadMenu
// has no cached GeoJSON string available (i.e. the cleaned-input fallback
// after a pipeline OOM, where building a JS string would re-trigger the
// heap exhaustion). GDAL streams output through OPFS instead.
export const gdalGeoJSONFormat: ExportFormat = {
  id: "gdal:GeoJSON",
  label: "GeoJSON (.geojson)",
  ext: ".geojson",
  mime: "application/geo+json",
  kind: "gdal",
  driver: "GeoJSON",
  rank: 5,
};

let cachedSpatialFormats: Promise<ExportFormat[]> | null = null;

export function resetFormatsCache(): void {
  cachedSpatialFormats = null;
}

export async function listFormats(source?: ExportSource): Promise<ExportFormat[]> {
  const kind: SourceKind = source ? SOURCES[source].kind : "spatial";
  if (kind === "tabular") return tabularFormats();
  if (!cachedSpatialFormats) cachedSpatialFormats = discoverSpatialFormats();
  return cachedSpatialFormats;
}

function tabularFormats(): ExportFormat[] {
  // Plain tabular sources (e.g. crosswalk_changelog): no geometry, no GDAL drivers.
  // CSV is the primary readable export; Parquet rides the same native COPY path
  // (FORMAT PARQUET) as the spatial Parquet export.
  return [
    {
      id: "csv",
      label: "CSV (.csv)",
      ext: ".csv",
      mime: "text/csv",
      kind: "csv",
      rank: 1,
    },
    {
      id: "parquet",
      label: "Parquet (.parquet)",
      ext: ".parquet",
      mime: "application/vnd.apache.parquet",
      kind: "parquet",
      rank: 10,
    },
  ];
}

async function discoverSpatialFormats(): Promise<ExportFormat[]> {
  const conn = duckdbState.conn;
  if (!conn) throw new Error("DuckDB is not ready yet.");

  // GeoJSON is intentionally omitted: the primary download button already
  // serves the cached GeoJSON, so listing it here would duplicate that entry.
  const formats: ExportFormat[] = [];

  const seenLabels = new Set<string>();
  const pushUnique = (f: ExportFormat) => {
    if (seenLabels.has(f.label)) return;
    seenLabels.add(f.label);
    formats.push(f);
  };

  // Intersect the curated KNOWN_DRIVERS set with what the loaded spatial
  // extension actually supports. A future build that drops a driver simply
  // hides the corresponding menu entry; nothing surfaces beyond the curated
  // list.
  const drivers = await conn.query("SELECT short_name FROM ST_Drivers() WHERE can_create");
  const available = new Set(
    (drivers.toArray() as Array<{ short_name: string }>).map((r) => r.short_name),
  );

  for (const [shortName, meta] of Object.entries(KNOWN_DRIVERS)) {
    if (!available.has(shortName)) continue;
    pushUnique({
      id: `gdal:${shortName}`,
      label: meta.label,
      ext: meta.ext,
      mime: meta.mime,
      kind: "gdal",
      driver: shortName,
      rank: meta.rank,
    });
  }

  pushUnique({
    id: "parquet",
    label: "GeoParquet (.parquet)",
    ext: ".parquet",
    mime: "application/vnd.apache.parquet",
    kind: "parquet",
    rank: 10,
  });

  formats.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.label.localeCompare(b.label);
  });
  return formats;
}

export async function runExport(
  source: ExportSource,
  format: ExportFormat,
  filenameStem: string,
  cachedGeoJSON?: string,
): Promise<ExportResult> {
  const { suffix } = SOURCES[source];
  const filename = `${filenameStem}${suffix}${format.ext}`;

  switch (format.kind) {
    case "geojson_cached": {
      if (!cachedGeoJSON) throw new Error("No cached GeoJSON to download.");
      return {
        blob: new Blob([cachedGeoJSON], { type: format.mime }),
        filename,
      };
    }
    case "gdal":
      return exportGdal(source, format, filenameStem);
    case "parquet":
      return exportParquet(source, format, filenameStem);
    case "csv":
      return exportCsv(source, format, filenameStem);
  }
}

function requireDb(): { db: AsyncDuckDB; conn: AsyncDuckDBConnection } {
  const db = duckdbState.db;
  const conn = duckdbState.conn;
  if (!db || !conn) throw new Error("DuckDB is not ready yet.");
  return { db, conn };
}

function exportId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function vfsName(ext: string): string {
  return `__edge_export_${exportId()}${ext}`;
}

async function readOpfsFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array> {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function removeOpfsEntries(name: string): Promise<void> {
  // Best-effort cleanup of the main file plus any SQLite siblings GDAL's
  // GPKG driver may have left behind.
  const root = await navigator.storage.getDirectory();
  for (const sfx of ["", "-journal", "-wal", "-shm"]) {
    try {
      await root.removeEntry(name + sfx);
    } catch {
      // not present — fine
    }
  }
}

function quotePath(p: string): string {
  return "'" + p.replace(/'/g, "''") + "'";
}

async function dropFileSafe(db: AsyncDuckDB, name: string): Promise<void> {
  try {
    await db.dropFile(name);
  } catch {
    // best-effort cleanup; leaks are page-session-scoped
  }
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  // Copy into a fresh ArrayBuffer so the Blob constructor's BlobPart type
  // resolves cleanly under SharedArrayBuffer-aware DOM lib typings.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Blob([ab], { type });
}

async function buildSpatialSelect(
  conn: AsyncDuckDBConnection,
  source: SourceConfig,
  geomExpr: string,
): Promise<string> {
  if (!source.attrTable) {
    // Source carries its own props on the row. An explicit allowlist (when
    // given) takes precedence; otherwise passthrough every non-geom column.
    let cols: string[];
    if (source.columns) {
      cols = source.columns.map((c) => `a.${JSON.stringify(c)}`);
    } else {
      const desc = await conn.query(`DESCRIBE ${source.table}`);
      const schema = desc.toArray() as Array<{ column_name: string; column_type: string }>;
      cols = schema
        .filter((r) => r.column_name !== "geom")
        .map((r) => `a.${JSON.stringify(r.column_name)}`);
    }
    const extra = cols.length > 0 ? ", " + cols.join(", ") : "";
    return `SELECT ${geomExpr}${extra} FROM ${source.table} AS a WHERE a.geom IS NOT NULL`;
  }
  const attrDesc = await conn.query(`DESCRIBE ${source.attrTable}`);
  const attrSchema = attrDesc.toArray() as Array<{
    column_name: string;
    column_type: string;
  }>;
  const isIncompatible = (t: string) =>
    t === "BLOB" ||
    t === "HUGEINT" ||
    t === "UHUGEINT" ||
    t.startsWith("STRUCT") ||
    t.startsWith("MAP") ||
    t.includes("[]");
  const attrExprs = attrSchema
    .filter((r) => r.column_name !== "fid")
    .map((r) => {
      const col = JSON.stringify(r.column_name);
      return isIncompatible(r.column_type) ? `CAST(b.${col} AS VARCHAR) AS ${col}` : `b.${col}`;
    });
  const cols = attrExprs.length > 0 ? ", " + attrExprs.join(", ") : "";
  return `SELECT ${geomExpr}${cols} FROM ${source.table} AS a LEFT JOIN ${source.attrTable} AS b ON a.fid = b.fid WHERE a.geom IS NOT NULL`;
}

async function buildTabularSelect(source: SourceConfig): Promise<string> {
  return `SELECT * FROM ${source.table}`;
}

async function exportGdal(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  const { suffix } = cfg;
  const meta = format.driver ? KNOWN_DRIVERS[format.driver] : undefined;
  const select = await buildSpatialSelect(conn, cfg, "ST_Multi(a.geom) AS geom");

  const layerOptionsClause =
    meta?.layerOptions && meta.layerOptions.length > 0
      ? `, LAYER_CREATION_OPTIONS (${meta.layerOptions.map(quotePath).join(", ")})`
      : "";

  const layerName = `${stem}${suffix}`;
  const layerNameClause = `, LAYER_NAME ${quotePath(layerName)}`;
  // The pipeline transforms input geometries to EPSG:4326 (loader.ts) and
  // the DB session sets geometry_always_xy=true, so all output GDAL drivers
  // should declare WGS84 explicitly. Without this, GDAL writes no CRS info
  // (no .prj for Shapefile, "Undefined geographic SRS" in GPKG, no
  // srsName in GML).
  const srsClause = `, SRS 'EPSG:4326'`;
  const filename = `${layerName}${format.ext}`;

  const root = await navigator.storage.getDirectory();
  const baseName = `__edge_export_${exportId()}`;

  if (format.driver === "ESRI Shapefile") {
    // Shapefile is multi-file. Pre-register OPFS handles for each
    // companion (.shp/.shx/.dbf/.prj/.cpg) so GDAL can write through
    // them, then bundle the results with fflate. /vsizip/ would be
    // cleaner but rejects the random-write pattern Shapefile uses.
    const exts = [".shp", ".shx", ".dbf", ".prj", ".cpg"];
    const companions: Array<{ ext: string; name: string; handle: FileSystemFileHandle }> = [];
    for (const ext of exts) {
      const fname = `${baseName}${ext}`;
      const handle = await root.getFileHandle(fname, { create: true });
      await db.registerFileHandle(fname, handle, DuckDBDataProtocol.BROWSER_FSACCESS, true);
      companions.push({ ext, name: fname, handle });
    }
    try {
      await conn.query(
        `COPY (${select}) TO ${quotePath(`${baseName}.shp`)} WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile'${srsClause}${layerNameClause}${layerOptionsClause})`,
      );
      const filesToZip: Record<string, Uint8Array> = {};
      for (const c of companions) {
        const file = await c.handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > 0) {
          filesToZip[`${layerName}${c.ext}`] = bytes;
        }
      }
      if (!filesToZip[`${layerName}.shp`]) {
        throw new Error("Shapefile export produced no .shp output");
      }
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        fflateZip(filesToZip, (err, data) => (err ? reject(err) : resolve(data)));
      });
      return { blob: toBlob(zipped, format.mime), filename };
    } finally {
      for (const c of companions) {
        await dropFileSafe(db, c.name);
        try {
          await root.removeEntry(c.name);
        } catch {
          // not present — fine
        }
      }
    }
  }

  // Single-file OPFS branch (GPKG, FlatGeobuf, KML, LIBKML, GML).
  // Bypass the runtime's auto-OPFS path scanning (which opens an exclusive
  // SyncAccessHandle on opfs:// paths and conflicts with SQLite's own open
  // call inside GDAL's GPKG driver, surfacing as "file is in use"). Instead
  // we acquire the OPFS FileSystemFileHandle ourselves and register it via
  // registerFileHandle with a plain name; the auto-OPFS regex only matches
  // single-quoted opfs:// literals so this name is invisible to it. After
  // COPY, we read the bytes back through the same FileSystemFileHandle.
  const name = `${baseName}${format.ext}`;
  const fileHandle = await root.getFileHandle(name, { create: true });
  await db.registerFileHandle(name, fileHandle, DuckDBDataProtocol.BROWSER_FSACCESS, true);
  try {
    await conn.query(
      `COPY (${select}) TO ${quotePath(name)} WITH (FORMAT GDAL, DRIVER ${quotePath(format.driver!)}${srsClause}${layerNameClause}${layerOptionsClause})`,
    );
    const bytes = await readOpfsFileBytes(fileHandle);
    return { blob: toBlob(bytes, format.mime), filename };
  } finally {
    await dropFileSafe(db, name);
    await removeOpfsEntries(name);
  }
}

async function exportParquet(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  const select =
    cfg.kind === "tabular"
      ? await buildTabularSelect(cfg)
      : await buildSpatialSelect(conn, cfg, "a.geom AS geometry");

  const path = vfsName(format.ext);
  try {
    await conn.query(`COPY (${select}) TO ${quotePath(path)} (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 15, GEOPARQUET_VERSION 'BOTH')`);
    const bytes = await db.copyFileToBuffer(path);
    return {
      blob: toBlob(bytes, format.mime),
      filename: `${stem}${cfg.suffix}${format.ext}`,
    };
  } finally {
    await dropFileSafe(db, path);
  }
}

async function exportCsv(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  if (cfg.kind !== "tabular") {
    throw new Error(`CSV export is only supported for tabular sources (got ${source}).`);
  }
  const select = await buildTabularSelect(cfg);
  const path = vfsName(format.ext);
  try {
    await conn.query(`COPY (${select}) TO ${quotePath(path)} (FORMAT CSV, HEADER)`);
    const csv = await db.copyFileToBuffer(path);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const bytes = new Uint8Array(bom.byteLength + csv.byteLength);
    bytes.set(bom, 0);
    bytes.set(new Uint8Array(csv), bom.byteLength);
    return {
      blob: toBlob(bytes, format.mime),
      filename: `${stem}${cfg.suffix}${format.ext}`,
    };
  } finally {
    await dropFileSafe(db, path);
  }
}
