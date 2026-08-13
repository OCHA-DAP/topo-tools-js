// Gap-width / snapping slider helpers, layered on the shared latitude-aware
// deg⇄m conversion in $lib/db/units.

import { cosLatFactor, METERS_PER_DEGREE } from "$lib/db/units";

// Sentinel gap-fill width for All mode: large enough to exceed any real gap
// by construction, so All doesn't need to first measure the widest one.
// Matches topo-tools-py's GAP_MAXIMUM_WIDTH_ALL_DEG (ADR-0034).
export const GAP_MAXIMUM_WIDTH_ALL_DEG = 360.0;

// Convert a slider value in meters to degrees. Negative values are the "auto"
// sentinel (snapping_distance = -1) and pass through unconverted. Zero stays
// zero (gap_maximum_width = 0 → no gap filling).
export function metersToDegrees(meters: number): number {
  if (meters < 0) return -1;
  if (meters === 0) return 0;
  return meters / (METERS_PER_DEGREE * cosLatFactor());
}

// Round n up to the nearest 1/2/5 × 10^k. Used for slider ceilings and steps.
export function niceNum(n: number): number {
  if (n <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / mag;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * mag;
}
