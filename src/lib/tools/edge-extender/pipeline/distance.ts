import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// No longer user-configurable: computeEffectiveDistance derives a per-file distance from the
// browser's memory budget and each file's own natural resolution, so this only serves as (a)
// the floor for boundaries with no fine natural detail (min(DEFAULT_DISTANCE, naturalRes) —
// naturalRes always wins when finer, so this can never coarsen an already-detailed file) and
// (b) a fallback for edge cases (no real segments; memory floor already blown before any
// resampling). Ported from edge-extender's config.py: a manual override never won over
// natural-resolution auto-detection anywhere it mattered.
export const DEFAULT_DISTANCE = 0.0002;

// Memory model for computeEffectiveDistance's per-file distance budget: a distance-independent
// segment decompose+remerge floor, a fixed startup overhead, and a distance-dependent final-
// point cost. Ported verbatim from edge-extender's fitted constants (measured inside a real
// --memory=4g --memory-swap=4g Docker container against native GEOS RSS) — these are NOT yet
// calibrated for the WASM heap model (physical-page-only memory.grow(), no swap, different
// per-allocation overhead than a native GEOS process) and should be treated as a provisional
// safeguard pending real-device recalibration. See docs/performance.md.
const REMERGE_BYTES_PER_RAW_SEGMENT = 850;
const BASELINE_OVERHEAD_MB = 500;
const BYTES_PER_POINT = 1900;
const SAFETY_MARGIN = 0.7;

// Parses DuckDB's current_setting('memory_limit') (e.g. "3.1 GiB", "500.0 MiB") into MB.
function parseMemoryLimitMb(value: string): number | null {
  const m = /^([\d.]+)\s*([KMGT])iB$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const exponent = { K: -1, M: 0, G: 1, T: 2 }[unit] ?? 0;
  return n * 1024 ** exponent;
}

// Assumes buildSegments (points.ts) has already created layer_03_tmp1.
//
// effective_distance = MAX(MIN(DEFAULT_DISTANCE, naturalRes), totalLength / targetPointBudget).
// naturalRes (median real segment length) lets files with genuinely finer source detail than
// DEFAULT_DISTANCE start there instead of losing that detail to a coarser default; the budget
// term protects files whose exterior boundary would otherwise generate more points than the
// browser's memory_limit can safely hold. Neither term can affect files whose segments are
// pathologically long — MAX_POINTS_PER_SEGMENT (points.ts) caps those independently.
//
// Before any of that, raw-segment-count-driven memory (decomposing into real segments, then
// remerging the normal ones per fid) is checked against memory_limit: this cost is independent
// of distance, so no amount of doubling it in the retry loop can rescue a file whose raw vertex
// count alone already exceeds the budget. memory_limit is a soft target, not a hard limit —
// this only logs a warning and falls back to DEFAULT_DISTANCE; it never refuses to attempt.
export async function computeEffectiveDistance(conn: AsyncDuckDBConnection): Promise<number> {
  const statsResult = await conn.query(`--sql
    SELECT median(seg_len) AS natural_res, sum(seg_len) AS total_length, count(*) AS n
    FROM layer_03_tmp1
  `);
  const stats = statsResult.toArray()[0] as { natural_res: number | null; total_length: number | null; n: bigint | number };
  const naturalRes = stats.natural_res;
  const totalLength = stats.total_length;
  const rawSegmentCount = Number(stats.n);

  if (naturalRes === null || totalLength === null) {
    console.info("distance-calc: no real segments, using default");
    return DEFAULT_DISTANCE;
  }

  const memLimitResult = await conn.query("SELECT current_setting('memory_limit') AS v");
  const memLimitStr = (memLimitResult.toArray()[0] as { v: string }).v;
  const memoryMb = parseMemoryLimitMb(memLimitStr);
  if (memoryMb === null) {
    console.warn(`distance-calc: could not parse memory_limit=${memLimitStr}, using default`);
    return DEFAULT_DISTANCE;
  }

  const remergeFloorMb = (rawSegmentCount * REMERGE_BYTES_PER_RAW_SEGMENT) / 1_000_000;
  const usableMb = memoryMb - BASELINE_OVERHEAD_MB - remergeFloorMb;

  if (usableMb <= 0) {
    console.warn(
      `distance-calc: ${rawSegmentCount.toLocaleString()} raw boundary segments need ~${remergeFloorMb.toFixed(0)}MB to decompose and remerge alone, exceeding the ~${memoryMb.toFixed(0)}MB budget (memory_limit=${memLimitStr}) before any resampling is applied — attempting anyway with DEFAULT_DISTANCE since memory_limit is a soft target`,
    );
    return DEFAULT_DISTANCE;
  }

  const targetPointBudget = (usableMb * SAFETY_MARGIN * 1_000_000) / BYTES_PER_POINT;
  const budgetFloor = totalLength / targetPointBudget;
  const candidate = Math.min(DEFAULT_DISTANCE, naturalRes);
  const effectiveDistance = Math.max(candidate, budgetFloor);

  console.info(
    `distance-calc: raw_segments=${rawSegmentCount} remerge_floor_mb=${remergeFloorMb.toFixed(0)} target_point_budget=${targetPointBudget.toFixed(0)} natural_res=${naturalRes} total_length=${totalLength} budget_floor=${budgetFloor} effective=${effectiveDistance}`,
  );

  return effectiveDistance;
}
