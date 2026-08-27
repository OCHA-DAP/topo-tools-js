# Edge Extender

Extends every polygon in a layer outward to close gaps with its neighbors,
using a Voronoi diagram of points sampled along each polygon's boundary.
Fully automatic — no user-configurable parameters; point spacing is derived
from the input.

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
3. **Points** (`pipeline/points.ts`), decomposes the remaining boundary
   into real vertex-to-vertex segments and interpolates points along them
   at a per-file distance (see "Point spacing" below). Segments longer than
   `distance × 100` are capped independently to avoid feeding
   `ST_VoronoiDiagram` a pathologically large exactly-collinear point
   cluster (e.g. long straight desert admin lines). The per-fid
   shared-boundary zone used to exclude junction points is itself built
   from a bbox-prefiltered union of nearby buffered boundary pieces, not a
   single whole-file `ST_Union_Agg`, so it stays cheap at real-catalog
   scale, the same fix already applied to step 2's neighbor union.
4. **Voronoi** (`pipeline/voronoi.ts`), builds a Voronoi diagram over every
   sampled point, then assigns each cell back to its source polygon's fid
   by point-in-polygon join.
5. **Merge** (`pipeline/merge.ts`), for each fid, takes its Voronoi cell's
   remainder (the cell minus whatever's already covered by a nearby
   original polygon) and unions it with the original polygon via a direct
   `ST_Union_Agg`. The merged result is checked against the loaded input by
   the shared no-erosion guard (`$lib/db/coverage.ts::checkNoErosion`, see
   `docs/reference/shared.md`), a hard failure rather than a warn-only
   check, before (unless the caller is Edge Matcher's per-group loop) a
   single gated `ST_CoverageClean` pass closes any residual seams in the
   assembled output.

## Point spacing

Point spacing is not user-supplied. `distance.ts`'s
`computeEffectiveDistance` derives it per file as
`min(DEFAULT_DISTANCE, naturalRes)`, where `naturalRes` is the median real
segment length — boundaries with genuinely finer detail than the default
start there instead of losing it to a coarser default. Falls back to
`DEFAULT_DISTANCE` when the input has no real segments.

If a spacing attempt still fails (too many points, or a Voronoi/points-stage
error), `pipeline/index.ts`'s outer retry loop doubles the distance and
tries again, up to 10 attempts.

## WASM-only GEOS noding failures

Running this pipeline in the browser (DuckDB WASM) can surface a class of
GEOS robustness failure — `TopologyException: found non-noded intersection`
— that does not reproduce natively. The failures come from a Voronoi cell
drifting by single-digit millimeters to a few meters from the boundary it's
supposed to exactly coincide with, and GEOS's noding step throwing on the
resulting near-but-not-quite-coincident seam. See
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence)
for the general pattern. `merge.ts` snaps each polygon to its neighbors'
union (`ST_Snap`, tolerance from `SNAP_TOLERANCE`) before differencing, which
resolves most near-coincident seams; a noding failure that survives the snap
propagates as a normal pipeline error rather than being retried — see
[`docs/adr/0022-noding-precision-retry-removed-for-python-parity.md`](../adr/0022-noding-precision-retry-removed-for-python-parity.md)
for why the earlier precision-reduction retry was removed.
