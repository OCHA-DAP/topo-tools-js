// Retry helper for a WASM-only GEOS noding failure ("found non-noded
// intersection") caused by floating-point drift between geometries meant to
// coincide exactly. Success isn't monotonic with precision, so this sweeps a
// dense set of candidates rather than picking one value, applied only to
// derived geometry, never real input.

// 0.1mm through 111mm: every 1x-9x step within {1e-9, 1e-8, 1e-7}, plus 1e-6.
const PRECISION_DECADES = [1e-9, 1e-8, 1e-7];
export const NODING_RETRY_PRECISIONS: number[] = [
  ...PRECISION_DECADES.flatMap((decade) =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => d * decade),
  ),
  1e-6,
];

// Runs `attempt` once per candidate precision, stopping at the first that
// succeeds; throws only once every candidate has failed.
export async function withNodingRetry(
  attempt: (precision: number) => Promise<void>,
  precisions: number[] = NODING_RETRY_PRECISIONS,
): Promise<void> {
  let lastError: unknown;
  for (const precision of precisions) {
    try {
      await attempt(precision);
      return;
    } catch (e) {
      lastError = e;
      console.warn(`Noding retry failed (precision=${precision}):`, e);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed after ${precisions.length} precision attempts: ${msg}`);
}
