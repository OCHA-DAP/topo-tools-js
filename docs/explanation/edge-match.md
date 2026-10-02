# Edge Matcher

Assigns a fine (input) layer to coarse (overlay) polygons, by default all of
it to the one overlay feature most input features overlap (assign-one, as
topo-tools-py's `edge-match`), optionally each input feature to the overlay
feature it overlaps most (per-feature). Groups input features by their assigned overlay feature, then
runs Edge Extender's pipeline independently within each group so the
group's result meets its own overlay feature boundary exactly. Automatic by default;
an optional code-based assignment override is available (see below).

## Pipeline

1. **Load** (`pipeline/load.ts`) — load both layers, then proactively clean
   each with a gated `ST_CoverageClean` (see
   [`0012`](../adr/0012-match-cleans-parent-and-child-inputs-on-load.md)).
   Real source data commonly carries pre-existing seam imprecision that this
   pipeline's later per-group clip step has no way to fix downstream.
2. **Assign** (`pipeline/assign.ts`), by default runs Clip's `assignOne`
   (`docs/explanation/edge-clip.md`), assigning every input feature, overlapping
   or not, to the majority-vote winner. With the per-feature option it
   instead computes area-overlap pairs between every input feature and
   nearby overlay feature (`src/lib/db/overlap.ts`, shared with the Changelog
   tool) and assigns each input feature to the overlay feature with the
   largest shared area (plurality, not necessarily >50%). Input features
   left without an overlay feature go to `ge_unassigned` instead of being
   silently dropped. With
   the opt-in passthrough toggle, those same input features are also inserted
   into `ge_assignment` under a sentinel `PASSTHROUGH_OVERLAY_FID` (`-1`,
   `pipeline/groups.ts`), turning them into their own pseudo-group instead
   of only being reported as excluded.
3. **Per-group extend** (`pipeline/groups.ts`), for each non-empty overlay feature
   group (including the passthrough pseudo-group, when present), populates
   `layer_01`/`layer_attr` with that group's input feature subset and runs Edge
   Extender's pipeline unmodified (`skipOutputClean: true`, since cleaning
   per-group here would be redundant, see
   [`0004`](../adr/0004-consolidate-coverageclean-to-single-final-call.md)).
   The extended result is checked against its own pre-extension subset by
   the shared no-erosion guard (`docs/reference/shared.md`) as a hard
   failure, then clipped against the known overlay feature geometry by the
   shared clip engine (`src/lib/db/clipEngine.ts`, the same one Clip and
   Mosaic use, as in topo-tools-py), except the passthrough group, which
   has no real overlay feature boundary and lands in `ge_results` unclipped.
   Each clipped group's detached pieces are merged or kept against the
   whole pre-extension input (`input_layer_01`, see
   `docs/explanation/edge-clip.md`), accumulating rows in `ge_detached`.
   An extended input feature whose clip comes out empty is recorded in
   `ge_clip_empty`, which in assign-one mode is every input feature lying
   outside the winning overlay feature. A
   failing group's input features are recorded in `ge_dropped` (with the overlay feature
   fid and error message) rather than aborting the whole batch.
4. **Assemble** (`pipeline/index.ts`) — join clipped group results into
   `ge_results`, export it, then attempt a single gated
   `ST_CoverageClean` over the whole assembled batch (catches cross-group
   seams no per-group clean could see) and re-export if it succeeds. Export
   runs _before_ attempting this final clean specifically so a clean
   failure can never lose an already-correct result — see
   [`0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md).

## Issues export

`ge_unassigned` (input features left without an overlay feature), `ge_dropped` (input features
whose whole group's extension failed), `ge_clip_empty` (input features
clipped to nothing) and `ge_detached` (clip-detached pieces) are combined
into one `ge_issues` table, each row tagged with a `kind` (`unassigned`,
`dropped_group`, `clip-empty` or `detached-part`) and,
for dropped groups, the overlay feature fid and the error that caused the drop. When
the passthrough toggle is on and a formerly-unassigned input feature made it through
its pseudo-group into `ge_results`, it's also surfaced as a `passthrough`
row, so a user can see which of the reported unassigned input features were
actually included (unclipped) rather than dropped. This is exportable on
demand as `match_issues` and is the only way to recover the geometry of any
of these kinds, the UI's group list only shows dropped groups as status
text.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`overlayMatchColumn`/`inputMatchColumn` pair, `pipeline/assign.ts`'s
`computeAssignment` also computes an exact code join, restricted to
`(input feature, overlay feature)` pairs that already spatially overlap, alongside the
spatial vote above (per file in assign-one mode, per input feature in
per-feature mode). The code result wins whenever one exists, even on
disagreement; an input feature whose code has no overlapping overlay match falls back
to the spatial result. Both outcomes are recorded on `ge_assignment`
(`assignment_method`, `spatial_agrees`) and surfaced as `ge_issues` rows
(`kind='code-mismatch'`/`'code-fallback'`), alongside the existing
`unassigned`/`dropped_group` kinds. Ported from topo-tools-py's
`core/assign`; see `docs/adr/0029` and `docs/reference/shared.md` for the
full contract, and `src/lib/db/codeJoin.ts` for the shared implementation
`edge-mosaic` and `edge-clip` also use.

## Overlap computation

`src/lib/db/overlap.ts`'s `computeOverlapPairs` (shared with Changelog, Code
Update, and Schema Join) computes overlap via exact `ST_Intersection`, with a
per-pair snap fallback for the WASM-only GEOS robustness failure described in
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence).

## Optional schema fill

`edge-match` accepts an opt-in `fillSchema` flag (`$lib/db/fillCompose.ts`,
shared with `edge-stitch` and `edge-mosaic`) that cascades admin-hierarchy column
families down `ge_results_attr` in place, right after the attribute join and
before export, using `schema-fill`'s own depth-pin algorithm. See
`docs/explanation/schema-fill.md` for the algorithm; off by default, and a
no-op on output when disabled.

## Cross-group boundary seams

Because each group's extension is clipped independently against its own
overlay feature, adjacent groups' clipped edges can end up sampling the same
physical boundary line at different vertex densities — a real but
zero-area-cost defect that strict vertex-exact validators (QGIS's Topology
Checker, `ST_CoverageInvalidEdges_Agg`) flag as "gaps" even though total
area is exactly conserved. This is a deliberate accepted tradeoff, not an
unfixed bug — see
[`0011`](../adr/0011-near-miss-cross-group-edges-accepted-as-cosmetic.md)
for the full investigation and why a coarse-layer rebuild or global
`ST_Snap` wasn't adopted.
