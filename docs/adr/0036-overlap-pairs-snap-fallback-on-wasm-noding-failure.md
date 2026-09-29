# 0036: `computeOverlapPairs` retries a failing pair with the child snapped onto the parent

## Status

Accepted. Narrows [0022](0022-noding-precision-retry-removed-for-python-parity.md)
for overlap measurement only; 0022 still holds for the merge and clip steps.

## Context

Schema Join's NLD demo (342 CBS gemeenten against 12 Kadaster provincies)
failed in `computeOverlapPairs` with `TopologyException: found non-noded
intersection`. 19 of 683 candidate pairs threw, deterministically, in
DuckDB-WASM v1.5.5 (spatial `eb1e57c`, the newest `next` build). Native
DuckDB v1.5.5 computed all 683 from the same WKB without error, and every
input polygon was valid. topo-tools-py produced its reference output from
the same pair.

0022 removed JS-only fallbacks so that JS fails wherever Python fails. Here
Python succeeds and JS does not, so the failure itself is the parity gap.

Tested per failing pair, against native `ST_Intersection` areas:

| Approach                                                 | Pairs recovered                          | Accuracy                                                                                           |
| -------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Intersect part-by-part (Python's `assign_many`)          | 0/19                                     | n/a                                                                                                |
| `ST_Difference` instead of `ST_Intersection`             | 0/19                                     | n/a                                                                                                |
| `ST_Covers` short-circuit                                | 0/19 (no failing child is fully covered) | n/a                                                                                                |
| `ST_ReducePrecision` both sides, 1e-9° to 1e-7°          | 19/19                                    | up to ~60 m² off at 1e-7°                                                                          |
| `ST_Snap(a, b, 1e-8)` then intersect, every pair         | 19/19                                    | up to 420 m² off on the 664 pairs that never failed                                                |
| `ST_Snap(a, b, 1e-8)` then intersect, failing pairs only | 19/19                                    | within 0.009 m² (1.2e-10 of child area); plurality parent identical to native for 342/342 children |

Changelog's earlier point-sampling fallback (commit `0672282`) predates any
`ST_Snap` use in this repo, so snapping was never tried for this failure.
DuckDB's `TRY()` does not catch the GEOS error, so the fallback cannot stay
inside one set-based query.

## Decision

`computeOverlapPairs` runs the set-based intersection first. If it throws,
it rebuilds the overlap table pair by pair; a pair whose exact intersection
throws is retried with `ST_Snap(a, b, SNAP_TOLERANCE)` intersected with `b`.
A pair that throws after snapping still fails the call. The function logs
the snapped-pair count to the console; the UI does not show it, since the
snapped areas match native to within 1.2e-10 of the child's area.

## Consequences

Every caller gets the fallback: Changelog, Edge Matcher, Code Update, and
Schema Join. A run with no failing pair executes the same single query as
before. Verified:

- Schema Join NLD demo: output identical to topo-tools-py's reference
  (columns, row order, values, geometry at 1e-9°). A planted edge-case pair
  (no-parent, low-overlap, value-mismatch, NULL child value) also matched
  Python's layer and issues report row for row.
- Changelog, AFG admin2 v01 to v02: the set-based query threw, 4 pairs were
  snapped, and the run completed with 409 rows. SYR and BFA admin1 v01 to
  v02 never reached the fallback.

The pairwise pass issues one query per candidate pair, so a failing run on
a large layer is slower than the set-based path. Edge Matcher and Code
Update were not run against a failing pair.
