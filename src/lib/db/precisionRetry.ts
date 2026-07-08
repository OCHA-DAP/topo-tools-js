// Retry helper for a documented WASM-only GEOS noding-failure class — see
// docs/wasm-geos-noding-investigation.md for the full investigation. GEOS's
// noding step can throw "found non-noded intersection" when two geometries
// that are supposed to coincide at a shared boundary don't, by a few
// millimeters to centimeters, due to floating-point drift through an
// extension/interpolation pipeline. This does not reproduce natively — WASM
// GEOS only. Confirmed NOT a monotonic "coarser is safer" knob: success is
// chaotic with respect to the exact rounding grid (e.g. one real case: 11mm
// and 33mm both failed but 17-28mm in between succeeded, and 111mm
// separately succeeded too). So instead of picking one value, try many and
// accept the first that works.
//
// Callers apply the candidate precision to whichever specific table is
// suspected of carrying the pathological vertices — always the
// algorithmically-*derived* side of an operation (e.g. Voronoi-generated
// geometry), never real input data, so even the coarsest candidate here
// never costs real-world accuracy beyond what that derivation step already
// introduced.

// 0.1mm through 111mm: every 1x-9x step within {1e-9, 1e-8, 1e-7}, plus 1e-6.
// "All possible values" isn't a well-defined finite set for a continuous
// precision parameter, so this is as dense a discrete sweep as is worth
// doing — more distinct values tried means more chances one lands outside
// whatever this specific geometry's pathological rounding cells happen to
// be, since there's no way to predict in advance which ones those are.
const PRECISION_DECADES = [1e-9, 1e-8, 1e-7];
export const NODING_RETRY_PRECISIONS: number[] = [
  ...PRECISION_DECADES.flatMap((decade) =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => d * decade),
  ),
  1e-6,
];

// Runs `attempt` once per candidate precision, in order, stopping at the
// first that succeeds. `attempt` is responsible for applying the candidate
// (typically via ST_ReducePrecision on the suspect table) and producing
// whatever output the caller expects under its usual name — this helper
// only controls the retry loop, not the SQL. Throws only once every
// candidate has failed, wrapping the last error.
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
