# Edge Matcher

Assigns a fine (input) layer to coarse (overlay) polygons, either all of it
to the one overlay polygon most input polygons overlap (assign-one, the
"One" mode and topo-tools-py's default) or each input polygon to the overlay
polygon it overlaps most (per-polygon, "Many"). The default "auto" mode
picks between them from the data and shows the pick on the switch, so the
user can compare the other mode on the map
([`0052`](../adr/0052-match-defaults-to-auto-mode.md)). Groups input polygons by their assigned overlay polygon, then
runs Edge Extender's pipeline independently within each group so the
group's result meets its own overlay polygon boundary exactly. Spatial by default;
an optional code-based assignment override is available (see below).

## Pipeline

1. **Load** (`pipeline/load.ts`) — load both layers, then proactively clean
   each with a gated `ST_CoverageClean` (see
   [`0012`](../adr/0012-match-cleans-parent-and-child-inputs-on-load.md)).
   Real source data commonly carries pre-existing seam imprecision that this
   pipeline's later per-group clip step has no way to fix downstream.
2. **Assign** (`pipeline/assign.ts`), in assign-one mode runs Clip's `assignOne`
   (`docs/explanation/edge-clip.md`), assigning every input polygon, overlapping
   or not, to the majority-vote winner. Auto mode runs the same vote, then
   switches to per-polygon when fewer than half the input polygons overlap
   the winner. In per-polygon mode it
   instead computes area-overlap pairs between every input polygon and
   nearby overlay polygon (`src/lib/db/overlap.ts`, shared with the Changelog
   tool) and assigns each input polygon to the overlay polygon with the
   largest shared area (plurality, not necessarily >50%). Input polygons
   left without an overlay polygon go to `ge_unassigned` instead of being
   silently dropped. With
   the opt-in passthrough toggle, those same input polygons are also inserted
   into `ge_assignment` under a sentinel `PASSTHROUGH_OVERLAY_FID` (`-1`,
   `pipeline/groups.ts`), turning them into their own pseudo-group instead
   of only being reported as excluded.
3. **Per-group extend** (`pipeline/groups.ts`), for each non-empty overlay polygon
   group (including the passthrough pseudo-group, when present), populates
   `layer_01`/`layer_attr` with that group's input polygon subset and runs Edge
   Extender's pipeline unmodified (`skipOutputClean: true`, since cleaning
   per-group here would be redundant, see
   [`0004`](../adr/0004-consolidate-coverageclean-to-single-final-call.md)).
   The extended result is checked against its own pre-extension subset by
   the shared no-erosion guard (`docs/reference/shared.md`) as a hard
   failure, then clipped against the known overlay polygon geometry by the
   shared clip engine (`src/lib/db/clipEngine.ts`, the same one Clip and
   Mosaic use, as in topo-tools-py), except the passthrough group, which
   has no real overlay polygon boundary and lands in `ge_results` unclipped.
   Each clipped group's detached pieces are merged or kept against the
   whole pre-extension input (`input_layer_01`, see
   `docs/explanation/edge-clip.md`), accumulating rows in `ge_detached`.
   An extended input polygon whose clip comes out empty is recorded in
   `ge_clip_empty`, which in assign-one mode is every input polygon lying
   outside the winning overlay polygon. A
   failing group's input polygons are recorded in `ge_dropped` (with the overlay polygon
   fid and error message) rather than aborting the whole batch.
4. **Assemble** (`pipeline/index.ts`) — join clipped group results into
   `ge_results`, export it, then attempt a single gated
   `ST_CoverageClean` over the whole assembled batch (catches cross-group
   seams no per-group clean could see) and re-export if it succeeds. Export
   runs _before_ attempting this final clean specifically so a clean
   failure can never lose an already-correct result — see
   [`0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md).

## Issues export

`ge_unassigned` (input polygons left without an overlay polygon), `ge_dropped` (input polygons
whose whole group's extension failed), `ge_clip_empty` (input polygons
clipped to nothing) and `ge_detached` (clip-detached pieces) are combined
into one `ge_issues` table, each row tagged with a `kind` (`unassigned`,
`dropped_group`, `clip-empty` or `detached-part`) and,
for dropped groups, the overlay polygon fid and the error that caused the drop. When
the passthrough toggle is on and a formerly-unassigned input polygon made it through
its pseudo-group into `ge_results`, it's also surfaced as a `passthrough`
row, so a user can see which of the reported unassigned input polygons were
actually included (unclipped) rather than dropped. This is exportable on
demand as `match_issues` and is the only way to recover the geometry of any
of these kinds, the UI's group list only shows dropped groups as status
text.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`overlayMatchColumn`/`inputMatchColumn` pair, `pipeline/assign.ts`'s
`computeAssignment` also computes an exact code join, restricted to
`(input polygon, overlay polygon)` pairs that already spatially overlap, alongside the
spatial vote above (per file in assign-one mode, per input polygon in
per-polygon mode). The code result wins whenever one exists, even on
disagreement; an input polygon whose code has no overlapping overlay match falls back
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

## Cross-group boundary seams

Because each group's extension is clipped independently against its own
overlay polygon, adjacent groups' clipped edges can end up sampling the same
physical boundary line at different vertex densities — a real but
zero-area-cost defect that strict vertex-exact validators (QGIS's Topology
Checker, `ST_CoverageInvalidEdges_Agg`) flag as "gaps" even though total
area is exactly conserved. This is a deliberate accepted tradeoff, not an
unfixed bug — see
[`0011`](../adr/0011-near-miss-cross-group-edges-accepted-as-cosmetic.md)
for the full investigation and why a coarse-layer rebuild or global
`ST_Snap` wasn't adopted.
