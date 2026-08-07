// Meters ⇄ degrees conversion for the gap-width / snapping sliders.
//
// All data is normalized to EPSG:4326 (degrees) on load, so ST_CoverageClean's
// distance parameters are in degrees. Users reason in meters, so the sliders
// are meters and we convert here using a latitude-aware factor: one degree of
// longitude shrinks by cos(latitude), so we scale by the dataset's centroid
// latitude (cached once per load). This is approximate over very large
// north-south extents — adequate for a cleaning tolerance.

const METERS_PER_DEGREE = 111_320;

let centroidLat = 0;

export function setCentroidLat(lat: number): void {
  centroidLat = Number.isFinite(lat) ? lat : 0;
}

// Convert a slider value in meters to degrees. Negative values are the "auto"
// sentinel (snapping_distance = -1) and pass through unconverted. Zero stays
// zero (gap_maximum_width = 0 → no gap filling).
export function metersToDegrees(meters: number): number {
  if (meters < 0) return -1;
  if (meters === 0) return 0;
  // Guard cos near the poles so the factor never collapses to ~0.
  const cosLat = Math.max(Math.cos((centroidLat * Math.PI) / 180), 0.05);
  return meters / (METERS_PER_DEGREE * cosLat);
}

// Approximate an area expressed in square degrees (ST_Area on EPSG:4326 data) as
// square metres, using the dataset's centroid latitude. Used only for the
// human-readable area column in the issues table — not for any geometry math.
export function degSqToM2(areaDegSq: number): number {
  const cosLat = Math.max(Math.cos((centroidLat * Math.PI) / 180), 0.05);
  return areaDegSq * METERS_PER_DEGREE * METERS_PER_DEGREE * cosLat;
}

// Convert a scalar degree distance (e.g. MIC radius) to metres.
// Uses the latitude-scale constant (111 320 m/deg), which is exact for N-S
// distances and approximate for E-W; adequate for display-only widths.
export function degToM(deg: number): number {
  return deg * METERS_PER_DEGREE;
}

// Round n up to the nearest 1/2/5 × 10^k. Used for slider ceilings and steps.
export function niceNum(n: number): number {
  if (n <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / mag;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * mag;
}
