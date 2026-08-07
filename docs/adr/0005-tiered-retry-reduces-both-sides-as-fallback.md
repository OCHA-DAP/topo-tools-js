# 0005: Tiered retry escalates to reducing real input only when derived-only fails

## Status

Accepted

## Context

Smoke-testing plain Edge Extender on the *whole* 76-feature Panama adm2
dataset as a single monolithic pass (not per-group, as Edge Matcher calls
it) exhausted all 28 precision candidates from
[0001](0001-precision-retry-mitigates-wasm-noding-failures.md) and still
threw. Every prior verification of that fix ran `stageMerge` per-group, on
small subsets (5-20 features) — this was the first time it ran as one
monolithic 76-feature dissolve.

Isolated the failure to a single `ST_Union_Agg(geom) WHERE fid = 14` ("Santa
Isabel"). Not a scale/neighbor-count effect — Santa Isabel's bbox only
pulled in 5 distinct neighboring parts, well within already-verified group
sizes. Instead: the union combines two rows — the untouched real `layer_01`
polygon (full float64 precision, never reduced by design) and the derived
Voronoi remainder (already `ST_ReducePrecision`'d). Since only the derived
side is snapped to the retry grid, the two rows' supposedly coincident
boundary vertices can still land a few ULPs apart, which GEOS can report as
a crossing instead of a touch — the same failure class as
[0001](0001-precision-retry-mitigates-wasm-noding-failures.md), just at a
union step whose real-input side had never been included in the reduction.

Verified directly against the failing row: reducing only the derived side
failed at every one of the 28 candidates; reducing **both** sides at the
same per-attempt value succeeded at every candidate tested, including the
finest (0.1mm).

## Decision

`merge.ts`'s `attemptDissolve(conn, precision, reduceOriginalToo)` helper
takes a `reduceOriginalToo` flag. `stageMerge` calls `withNodingRetry` once
with `reduceOriginalToo = false` (derived-only, all 28 candidates, the
cheaper and preferred path, sufficient for the vast majority of cases);
only if that whole sweep throws does it catch and retry with a second
`withNodingRetry` pass at `reduceOriginalToo = true`. `layer_04_orig` (the
pristine, pre-reduction Voronoi output) is preserved across both tiers so
retries never compound precision loss from a previous failed attempt.

## Consequences

Plain `/extend`'s whole-dataset monolithic merge now succeeds (0 shrunk
features, 0 invalid geometries); `/match`'s per-group runs (including the
Santa Isabel group) remain 76/76, 0 unassigned, 0 invalid. Both tools use
the same, now-corrected shared fix — the "partition into small groups"
design was not what made Edge Matcher robust here, it just happened not to
exercise this particular gap in which side(s) of the union got the
retry treatment.
