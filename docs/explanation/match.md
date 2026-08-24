# Edge Matcher

Assigns every polygon in a fine ("child") layer to the coarse ("parent")
polygon it overlaps most, groups children by their assigned parent, then
runs Edge Extender's pipeline independently within each group so the
group's result meets its own parent boundary exactly. Automatic by default;
an optional code-based assignment override is available (see below).

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
   (`src/lib/db/clipToBoundary.ts`). A failing group's children are recorded
   in `ge_dropped` (with the parent fid and error message) rather than
   aborting the whole batch.
4. **Assemble** (`pipeline/index.ts`) — join clipped group results into
   `ge_results`, export it, then attempt a single gated
   `ST_CoverageClean` over the whole assembled batch (catches cross-group
   seams no per-group clean could see) and re-export if it succeeds. Export
   runs *before* attempting this final clean specifically so a clean
   failure can never lose an already-correct result — see
   [`0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md).

## Issues export

`ge_unassigned` (children with no parent overlap) and `ge_dropped` (children
whose whole group's extension failed) are combined into one `ge_issues`
table, each row tagged with a `kind` (`unassigned` or `dropped_group`) and,
for dropped groups, the parent fid and the error that caused the drop. This
is exportable on demand as `match_issues` and is the only way to recover the
geometry of either kind of exclusion — the UI's group list only shows
dropped groups as status text.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`parentMatchColumn`/`childMatchColumn` pair, `pipeline/assign.ts`'s
`computeAssignment` also computes an exact code join, restricted to
`(child, parent)` pairs that already spatially overlap, alongside the
plurality vote above. The code result wins whenever one exists, even on
disagreement; a child whose code has no overlapping-parent match falls back
to the spatial result. Both outcomes are recorded on `ge_assignment`
(`assignment_method`, `spatial_agrees`) and surfaced as `ge_issues` rows
(`kind='code-mismatch'`/`'code-fallback'`), alongside the existing
`unassigned`/`dropped_group` kinds. Ported from topo-tools-py's
`core/assign`; see `docs/adr/0029` and `docs/reference/shared.md` for the
full contract, and `src/lib/db/codeJoin.ts` for the shared implementation
`mosaic` and `clip` also use.

## Overlap computation

`src/lib/db/overlap.ts`'s `computeOverlapPairs` (shared with the Changelog
tool) computes overlap via exact `ST_Intersection`. A failure (the WASM-only
GEOS robustness class documented in
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence))
propagates to the caller rather than falling back to an approximation.

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
