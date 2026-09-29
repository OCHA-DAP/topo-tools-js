# 0037: The noding-failure fallbacks extend to assign-one, the clip step, and gap/overlap detection

## Status

Accepted. Extends [0036](0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md)
past `computeOverlapPairs`, and narrows
[0022](0022-noding-precision-retry-removed-for-python-parity.md) further:
0022 now holds for Edge Extender's merge step only.

## Context

0036's principle applies wherever topo-tools-py succeeds and DuckDB-WASM
v1.5.5 throws `TopologyException: found non-noded intersection` on the same
input. Three more places hit it on real CBS data:

- **Clip, NLD gemeenten against provincies** (#9): assign-one's
  input/overlay intersection threw on 19 pairs, and after that was fixed the
  clip step's own intersection threw on 2.
- **Detect, NLD 2025 admin4 (14,823 wijken)** (#10): the overlap self-join
  threw on 3 of 13 candidate pairs, and the gap check's whole-layer
  `ST_Union_Agg` threw. JS reported 0 issues against Python's 5 gaps and 10
  overlaps.

The pair-level failures have the same shape as 0036's, so `ST_Snap` on the
failing pair applies. The gap failure has no pair to snap. Tested on the
admin4 union:

| Approach                                       | Result                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `ST_Union_Agg` on dumped parts (Python's form) | throws                                                      |
| `ST_CoverageUnion_Agg`, `ST_MemUnion_Agg`      | throws                                                      |
| `ST_ReducePrecision(geom, 1e-13)` then union   | throws                                                      |
| `ST_ReducePrecision(geom, 1e-12)` then union   | 37 s; Python's 5 gaps plus hundreds of holes ≤ ~1e-12° wide |
| `ST_ReducePrecision(geom, 1e-11)` then union   | 28 s; Python's 5 gaps plus 76 holes ≤ 1e-11° wide           |

The extra holes are slits the grid opens between edges that coincide in the
original. A width cutoff would separate them here (the narrowest real gap is
3.1e-10° wide), but only by a factor of about 30. Testing each hole's
`ST_PointOnSurface` against the original polygons separates them without a
threshold: a slit's interior point lies on or inside an input polygon, and a
real gap's does not.

## Decision

- `intersectPairs` (0036's set-based-then-pairwise snap fallback) takes the
  pair predicate as a parameter and backs assign-one, the clip step, and the
  shared overlap check (`buildOverlapTable`) as well as `computeOverlapPairs`.
  Each logs its snapped-pair count.
- The shared gap check (`buildGapTable`) retries a failing union on a
  1e-11° grid and drops every hole whose interior point an input polygon
  intersects. A retry that still throws propagates, as before.

## Consequences

- Clip NLD completes, with per-feature geometry within ~1e-14 deg² of
  Python's. JS writes 80 features to Python's 79. The extra one is a
  4.6e-15 deg² Amersfoort sliver: WASM and native PROJ disagree by up to
  5.7e-14° on reprojected vertices, so a border that only touches natively
  overlaps by a sliver in WASM.
  [0040](0040-micro-polygons-merged-like-micro-gaps.md) merges it, along
  with every other micro-polygon.
- Detect NLD admin4 matches Python issue for issue, 5 gaps and 10 overlaps,
  each within 1.1e-14 deg² symmetric difference.
- Every other caller of the shared gap and overlap checks (Topology Cleaner,
  Stitch, Package Polygons, Edge Extender, `hasNoiseFloorGap`) gets the same
  fallbacks. A layer whose exact queries succeed runs the same SQL as before.
