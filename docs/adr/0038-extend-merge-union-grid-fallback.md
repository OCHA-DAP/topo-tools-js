# 0038: Edge Extender's merge dissolve retries a failing fid on a 1e-11° grid

## Status

Accepted. Narrows [0022](0022-noding-precision-retry-removed-for-python-parity.md)
to the merge step's cell difference only, following the
principle of [0036](0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md)
and the grid of [0037](0037-snap-and-grid-fallbacks-extended-past-overlap-pairs.md).

## Context

Edge Extender on a 15-feature Burundi admin2 subset threw `TopologyException:
found non-noded intersection` in `stageMerge`'s dissolve (`ST_Union_Agg` of
each fid's original geometry and Voronoi remainder), deterministically, in
DuckDB-WASM v1.5.5. topo-tools-py completed the same input. One fid failed:
its original polygon plus a single remainder piece.

Tested on that fid:

| Approach                                       | Result |
| ---------------------------------------------- | ------ |
| Python's `ST_Intersects` neighbor predicate    | throws |
| `ST_Union_Agg` on dumped parts                 | throws |
| `ST_MemUnion_Agg`                              | throws |
| `ST_CoverageUnion_Agg`                         | throws |
| Snap every piece onto the original, then union | throws |
| `ST_ReducePrecision(geom, 1e-11)` then union   | works  |

## Decision

- When the set-based dissolve throws, `stageMerge` unions fid by fid and
  retries a failing fid once on `ST_ReducePrecision(geom, 1e-11)`
  (`NODING_FALLBACK_GRID`, shared with the gap check). A retry that still
  throws propagates. The gridded-fid count is logged.
- The neighbor-union join also takes Python's `ST_Intersects(part, cell)`
  predicate, so the snap target matches Python's.

## Consequences

- The Burundi subset completes, matching Python on all 15 features within
  1e-16 deg² symmetric difference.
- The cell difference keeps 0022's fail-like-Python behavior until a case
  where Python succeeds and JS fails turns up there.
