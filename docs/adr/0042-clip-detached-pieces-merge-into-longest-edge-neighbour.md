# 0042: Clip-detached pieces merge into their longest-edge neighbour

## Status

Accepted. Ports topo-tools-py ADR 0120 (topo-tools-py #138).

## Context

Clipping an extended feature to its overlay feature can cut one of its
parts into several pieces wider than `SNAP_TOLERANCE`, which the
micro-polygon merge ([0040](0040-micro-polygons-merged-like-micro-gaps.md))
keeps and no issue row reports. topo-tools-py merges a piece under 1% of
its source part's kept piece into the same-overlay feature it shares the
longest edge with, unless the pre-extension original draws it as a lobe.
Its ADR 0120 holds the evidence for the ratio, the original-layer check
and the rejected absolute size caps.

## Decision

Port the rule to `$lib/db/coverage.ts` as `mergeDetachedParts`, with the
contract in `docs/reference/shared.md`.

- Clip and Mosaic call it through `mergeClipDetached`
  (`$lib/db/clipEngine.ts`) after `clipEngine`, before the micro-polygon
  merge and stitch. Edge Matcher calls it after each group's clip, with
  `input_layer_01` as the original.
- Clip and Mosaic take the original layer as an optional third DropZone
  (`original` URL param). The shared loader makes it valid on load, where
  topo-tools-py reads it raw and validates each part as it uses it.
- Every JS clip runs against one overlay feature, so the merge takes that
  overlay's fid and geometry directly and has no overlay column to match.
- Original-land shares go through `intersectPairs`. The edge-length,
  attach and clipped-away-land steps retry once on the 1e-11 grid when
  WASM GEOS throws, and the receiving-feature rebuild shares the
  micro-polygon merge's row-by-row snap fallback (`rebuildRowwise`, now
  taking the kept-parts predicate).
- `detached-part` rows carry `area_m2`, `max_width_m`, `thinness_ratio`
  and `fixed`, so Clip's and Edge Matcher's issues tables and exports
  gain those columns, and Mosaic's gains `fixed`.

## Consequences

- NLD admin2 extended per province (topo-tools-py `edge-extend`) and
  clipped to its admin1: Clip and Mosaic write the same `detached-part`
  rows as topo-tools-py `edge-clip --original` for Zuid-Holland (fid 50
  into 6), Utrecht (fid 9 into 11) and Flevoland (none), and report
  `kept: no original layer` without the original.
- NLD Edge Matcher demo (per feature): JS merges the 4 pieces topo-tools-py
  merges except fid 303 (`kept: merge did not attach`), and also merges a
  zero-area piece of fid 49 that topo-tools-py has no row for. Both are
  sub-square-metre crumbs from the WASM extension's fallbacks, which cut
  slightly different geometry than native GEOS.
