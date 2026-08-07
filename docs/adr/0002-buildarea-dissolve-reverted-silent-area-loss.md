# 0002: ST_BuildArea dissolve reconstruction reverted after a silent area-loss bug

## Status

Accepted

## Context

While diagnosing the noding-crash bug ([0001](0001-precision-retry-mitigates-wasm-noding-failures.md)),
`stageMerge`'s final dissolve was rewritten from a direct
`ST_Union_Agg(geom)` to boundary-line noding —
`ST_BuildArea(ST_Node(ST_Union_Agg(ST_Boundary(geom))))` — on the theory that
explicit noding would be more robust than the overlay union. This did not
fix the crash on its own (same coordinates, different algorithm — confirming
the instability was in the geometry, not the specific overlay code path),
but was kept anyway as a general robustness improvement, combined with the
precision retry.

This surfaced a distinct, non-crashing defect. `runValidation`'s
`GAPS in layer_05: N interior rings` warning (warn-only, never surfaced to
the UI) fired on 75 of 76 groups in a full real-batch run, previously
dismissed as pipeline noise. Cross-checking per-group output area against
each group's parent polygon area revealed deficits from 0% up to 80%; worst
case, a real feature ("Gobernadora") lost 99.6% of its own area. Root cause:
`ST_BuildArea` infers solid-vs-hole purely from ring nesting in the noded
line network, with no concept of "this ring came from real input, so it must
stay solid." For isolated features (e.g. a small island whose Voronoi cell
extends far into open water), the noded boundary arrangement can nest
backwards: the extension area becomes the inferred "solid" polygon, and the
original real polygon becomes a punched-out interior hole.

## Decision

Revert `stageMerge`'s final dissolve back to a direct `ST_Union_Agg(geom)`.
A plain polygon union has no ring-nesting ambiguity — GEOS's overlay union
determines solid-vs-hole via point-containment, not path traversal — so it
cannot invert real input into a hole. The precision retry from
[0001](0001-precision-retry-mitigates-wasm-noding-failures.md), not the
dissolve algorithm, was independently confirmed as what eliminates the
noding crash, so dropping `ST_BuildArea` carries no crash-rate cost.

This fix applies to both Edge Extender and Edge Matcher, since both call the
same shared `runPipeline`/`stageMerge`.

## Consequences

Full real-batch re-run after the revert: still 76/76 groups succeeded (no
crash regression), and per-group area deficit is 0.00% on every group
(Gobernadora recovered to its expected clipped area). The `GAPS`/interior-rings
warning still fired on most groups even after the revert — a separate,
much smaller residual defect, addressed by consolidating output-side
`ST_CoverageClean` calls (see
[0004](0004-consolidate-coverageclean-to-single-final-call.md)).
