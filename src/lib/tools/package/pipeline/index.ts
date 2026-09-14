import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  runPackageLines,
  type PackageLinesResult,
} from "$lib/tools/package-lines/pipeline/index";
import {
  runPackagePoints,
  type PackagePointsResult,
} from "$lib/tools/package-points/pipeline/index";
import {
  runPackagePolygons,
  type PackagePolygonsResult,
} from "$lib/tools/package-polygons/pipeline/index";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type {
  PackagePolygonsLevelResult,
  PackagePolygonsResult,
} from "$lib/tools/package-polygons/pipeline/index";
export type { PackagePointsResult } from "$lib/tools/package-points/pipeline/index";
export type { PackageLinesResult } from "$lib/tools/package-lines/pipeline/index";

export interface PackageResult {
  polygons: PackagePolygonsResult;
  points: PackagePointsResult;
  lines: PackageLinesResult;
}

// No table names collide across the three sub-pipelines (pp_/pkpt_/pl_ prefixes).
export async function runPackage(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<PackageResult> {
  const polygons = await runPackagePolygons(conn, schema);
  const points = await runPackagePoints(conn, schema);
  const lines = await runPackageLines(conn, schema);
  return { polygons, points, lines };
}
