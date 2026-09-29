# 0039: Edge Matcher clips through the shared clip engine, and `intersectPairs` gains a grid tier

## Status

Accepted. Extends [0036](0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md)
and [0037](0037-snap-and-grid-fallbacks-extended-past-overlap-pairs.md).

## Context

Edge Matcher on NLD gemeenten (342) into provincies (12) failed the
Utrecht group in DuckDB-WASM v1.5.5 with `TopologyException: found
non-noded intersection`, in the per-group clip. topo-tools-py
`edge-match --per-feature` completed every group.

That clip was `clipToBoundary`, a plain `ST_Intersection` with no fallback
and no boundary tiling. topo-tools-py's match clips each group through the
same engine as `edge-clip`.

Rerouted through `clipEngine`, two pairs still threw inside
`intersectPairs`:

| Approach                                     | Pair 136 | Pair 271 |
| -------------------------------------------- | -------- | -------- |
| `ST_Snap(a, b, 1e-8)` then intersect (0036)  | throws   | throws   |
| `ST_Snap(b, a, 1e-8)` then intersect         | throws   | works    |
| `ST_MakeValid(a)`, or intersect dumped parts | throws   | throws   |
| `ST_ReducePrecision(·, 1e-11)` on `a` only   | works    | works    |
| `ST_ReducePrecision(·, 1e-11)` on both sides | works    | works    |

## Decision

- Edge Matcher's per-group clip calls `clipEngine`, which now takes a source
  query, a boundary query and a target table. `clipToBoundary` is deleted.
- `intersectPairs` retries a pair whose snapped intersection also throws with
  both sides on `ST_ReducePrecision(geom, 1e-11)` (`NODING_FALLBACK_GRID`). A
  pair that still throws propagates. It logs its own snapped and gridded
  counts under a caller label.

## Consequences

- NLD Match completes every group. 328 of 342 features match Python within
  1e-10 deg². The other 14 are coastal or water units whose far-field
  Voronoi extension differs by up to ~1,200 m² between neighbors.
- BDI Match, NLD Clip and BDI Mosaic are unchanged against Python.
- Every `intersectPairs` caller gets the grid tier. A pair the snap already
  rescues takes the same path as before.
