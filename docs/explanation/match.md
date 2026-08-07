# Edge Matcher

Assigns every polygon in a fine ("child") layer to the coarse ("parent")
polygon it overlaps most, groups children by their assigned parent, then
runs Edge Extender's pipeline independently within each group so the
group's result meets its own parent boundary exactly. Fully automatic — no
user-configurable parameters.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load both layers, then proactively clean
   each with a gated `ST_CoverageClean` (see
   [`0012`](../adr/0012-match-cleans-parent-and-child-inputs-on-load.md)).
   Real source data commonly carries pre-existing seam imprecision that this
   pipeline's later per-group clip step has no way to fix downstream.
2. **Assign** (`pipeline/assign.ts`) — compute area-overlap pairs between
   every child and nearby parent (`src/lib/db/overlap.ts`, shared with the
   Changelog tool), then assign each child to the parent with the largest
   shared area (plurality, not necessarily >50%). Children with zero parent
   overlap go to `ge_unassigned` instead of being silently dropped.
3. **Per-group extend** (`pipeline/groups.ts`) — for each non-empty parent
   group, populate `layer_01`/`layer_attr` with that group's child subset
   and run Edge Extender's pipeline unmodified (`skipOutputClean: true`,
   since cleaning per-group here would be redundant — see
   [`0004`](../adr/0004-consolidate-coverageclean-to-single-final-call.md)),
   then clip the result against the known parent geometry
   (`src/lib/db/clipToBoundary.ts`). A failing group is recorded and skipped
   rather than aborting the whole batch.
4. **Assemble** (`pipeline/index.ts`) — join clipped group results into
   `ge_results`, export it, then attempt a single gated
   `ST_CoverageClean` over the whole assembled batch (catches cross-group
   seams no per-group clean could see) and re-export if it succeeds. Export
   runs *before* attempting this final clean specifically so a clean
   failure can never lose an already-correct result — see
   [`0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md).

## Overlap computation and its WASM fallback

`src/lib/db/overlap.ts`'s `computeOverlapPairs` tries an exact
`ST_Intersection`-based overlap computation first. On failure (the same
WASM-only GEOS robustness class documented in
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence)),
it falls back to a point-sampling estimate (a 32×32 grid per polygon plus a
guaranteed `ST_PointOnSurface`, so units too small/thin to catch a grid
point are never dropped) that computes coverage/IoU from point-in-polygon
counts instead of exact geometry — this fallback can't throw the same way
exact intersection can.

## Cross-group boundary seams

Because each group's extension is clipped independently against its own
parent, adjacent groups' clipped edges can end up sampling the same
physical boundary line at different vertex densities — a real but
zero-area-cost defect that strict vertex-exact validators (QGIS's Topology
Checker, `ST_CoverageInvalidEdges_Agg`) flag as "gaps" even though total
area is exactly conserved. This is a deliberate accepted tradeoff, not an
unfixed bug — see
[`0011`](../adr/0011-near-miss-cross-group-edges-accepted-as-cosmetic.md)
for the full investigation and why a coarse-layer rebuild or global
`ST_Snap` wasn't adopted.
