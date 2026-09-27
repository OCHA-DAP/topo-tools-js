export const SINGLE_EXTS = [
  ".parquet",
  ".geojson",
  ".geojsonl",
  ".gpkg",
  ".fgb",
  ".kml",
  ".gml",
  ".gpx",
];
export const SHP_EXTS = [".shp", ".dbf", ".shx", ".prj", ".cpg"];
export const CSV_EXTS = [".csv"];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}
