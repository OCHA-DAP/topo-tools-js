# Schema Join

Copies a join layer's admin-hierarchy columns onto every input polygon, from
the join polygon it overlaps most, without touching geometry: an admin 2
layer carrying only `adm2_code`/`adm2_name` gets `adm1_code`/`adm1_name` from
an admin 1 layer. Ported from topo-tools-py's `schema-join`, and named after
QGIS's "Join attributes by location" with the largest-overlap join type,
which it narrows to hierarchy columns. A source file often carries only its
own level's code; Schema Fill can't help, since it only cascades values
already on the row, and truncating a code to derive the level above fails
silently when codes don't nest. Schema Join derives the upper level from
geometry instead, and reports every case where that derivation is weak or
disagrees with a value the input polygon already has.

A join layer that already carries its own ancestors fills every level in one
run. Otherwise, chain runs coarsest-first: admin 2 against admin 1, then
admin 3 against the joined admin 2 download.

## Pipeline

1. **Load and assign** (`pipeline/index.ts`'s `loadAndAssign`, then
   `pipeline/assign.ts`), loads both layers with `input_`/`join_` prefixes
   and calls `assignBestOverlap`, then builds `sj_assign` and `sj_share`:
   each input polygon's area and the share its assigned join polygon covers,
   from `computeOverlapPairs`'s `coverage_a`. This step depends only on
   geometry, so it runs once per layer pair.
2. **Join** (`pipeline/join.ts`), resolves the join layer's hierarchy columns
   (templates via `templateFamilies`, or structural detection), then builds
   `sj_result_attr` by left-joining each input polygon to its assigned join
   polygon. Each column is added, skipped as identical, or added as a
   numbered sibling, and `sj_mismatch` records differing values.
   `__row_order` holds the output row number (sorted by the deepest code),
   which the export uses for row order.
3. **Issues** (`pipeline/issues.ts`), builds `sj_issues` from unassigned
   input polygons, `sj_share` rows below the minimum overlap, and
   `sj_mismatch`, keyed by output row number.

Steps 2 and 3 re-run when the minimum overlap or templates change.

## Why per-polygon plurality, not per-file majority

Clip and Mosaic force a whole input file onto one majority-vote overlay
polygon, since each of their input files sits inside a single one. A Schema
Join input layer is the opposite case: an admin 2 layer spans every admin 1
unit, so each input polygon needs its own join polygon.

## Why a low-overlap polygon is flagged, not rejected

When an input polygon's best join polygon covers less than the minimum
overlap (default 0.5) of its area, no single join polygon holds a majority of
it, which usually means the two layers' boundaries were digitized differently
or the polygon really straddles a boundary of the join layer. The plurality
pick is still the most likely match, so it is kept, and the `low-overlap`
issue marks it for review.

## Why a conflicting value is kept side by side

An input polygon's own value and its join polygon's are both source data,
and neither is reliably correct (e.g. a name with an accent in one layer and
without it in the other). Schema Join keeps the input column, adds the join
layer's values as the next free numbered sibling (`adm1_name1`), and writes a
`value-mismatch` issue per differing input polygon, leaving the choice to a
later review step.

## Overlap on independently digitized layers

Input and join layers from different producers have near-coincident borders,
which is where DuckDB-WASM's GEOS build can throw on an exact intersection.
`computeOverlapPairs` recovers those pairs by snapping (see
`docs/explanation/performance.md`).
