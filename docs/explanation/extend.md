# Edge Extender

Extends every polygon in a layer outward to close gaps with its neighbors,
using a Voronoi diagram of points sampled along each polygon's boundary.
Fully automatic — no user-configurable parameters; point spacing and retry
behavior are derived from the input and the browser's memory budget.

## Pipeline

1. **Clean input** (`pipeline/clean.ts`) — if `ST_CoverageInvalidEdges_Agg`
   flags any overlap/gap in the loaded input, run `ST_CoverageClean` on it
   in place first. Voronoi generation downstream assumes a clean starting
   coverage. No-op on already-clean input (see
   [`0013`](../adr/0013-clean-skips-coverageclean-when-no-defects.md)'s
   sibling gate in Topology Cleaner for why this only fires conditionally).
2. **Boundary lines** (`pipeline/lines.ts`) — extract each polygon's
   boundary, then subtract the union of its bbox-prefiltered neighbors so
   only the *non-shared* stretch of each boundary remains (shared/touching
   edges don't need extending).
3. **Points** (`pipeline/points.ts`) — decompose the remaining boundary
   into real vertex-to-vertex segments and interpolate points along them at
   a per-file distance (see "Point spacing" below). Segments longer than
   `distance × 100` are capped independently to avoid feeding
   `ST_VoronoiDiagram` a pathologically large exactly-collinear point
   cluster (e.g. long straight desert admin lines).
4. **Voronoi** (`pipeline/voronoi.ts`) — build a Voronoi diagram over every
   sampled point, then assign each cell back to its source polygon's fid by
   point-in-polygon join.
5. **Merge** (`pipeline/merge.ts`) — for each fid, take its Voronoi cell's
   remainder (the cell minus whatever's already covered by a nearby
   original polygon) and union it with the original polygon via a direct
   `ST_Union_Agg`. The result is unioned per fid, then (unless the caller is
   Edge Matcher's per-group loop) a single gated `ST_CoverageClean` pass
   closes any residual seams in the assembled output.

## Point spacing

Point spacing is not user-supplied. `distance.ts`'s
`computeEffectiveDistance` derives it per file as
`max(min(DEFAULT_DISTANCE, naturalRes), totalLength / targetPointBudget)`:
`naturalRes` (median real segment length) lets boundaries with genuinely
finer detail than the default start there instead of losing it to a coarser
default; the budget term protects files whose boundary would otherwise
generate more points than the browser's `memory_limit` can hold. A file
whose raw (pre-resampling) segment count alone already exceeds the budget
falls back to the default distance with a console warning — the budget is a
soft target, not a hard gate.

If a spacing attempt still fails (too many points, or a Voronoi/points-stage
error), `pipeline/index.ts`'s outer retry loop doubles the distance and
tries again, up to 10 attempts.

## WASM-only GEOS noding failures

Running this pipeline in the browser (DuckDB WASM) surfaces a class of GEOS
robustness failure — `TopologyException: found non-noded intersection` —
that does not reproduce natively. The failures come from a Voronoi cell
drifting by single-digit millimeters to a few meters from the boundary it's
supposed to exactly coincide with, and GEOS's noding step throwing on the
resulting near-but-not-quite-coincident seam. See
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence)
for the general pattern and
[`docs/adr/0001-precision-retry-mitigates-wasm-noding-failures.md`](../adr/0001-precision-retry-mitigates-wasm-noding-failures.md)
onward for the full decision history: a shared precision-reduction retry
helper (`src/lib/db/precisionRetry.ts`) is applied wherever this pipeline
combines derived (algorithmically-generated) geometry with real input —
never to real input directly — and a tiered fallback escalates to reducing
both sides only when the derived-only sweep is exhausted.
