# 0040: Micro-polygons are merged like micro gaps are filled

## Status

Accepted. Ports topo-tools-py ADR 0117 (topo-tools-py #123).

## Context

Clip on NLD gemeenten against provincies wrote the Amersfoort sliver of
[0037](0037-snap-and-grid-fallbacks-extended-past-overlap-pairs.md), a
feature narrower than `SNAP_TOLERANCE`. Gaps that narrow were already
filled everywhere geometry is modified, but polygon parts that narrow
were kept.

`ST_CoverageClean(geoms, 1e-8, 1e-8)` absorbs overlap slivers, touching
fragments and detached micro islands identically in native DuckDB and
DuckDB-WASM, but returns a feature that is entirely micro as EMPTY.
`ST_CoverageInvalidEdges_Agg` doesn't flag a micro feature that only
touches its neighbours, so the gated clean skipped them.

## Decision

Port topo-tools-py's rule to `$lib/db/coverage.ts`: `isMicroSql`,
`hasMicroPolygons` and `mergeMicroPolygons`, with the definition, merge
target and issue row in `docs/reference/shared.md`.

- `buildCoverageClean` merges before `ST_CoverageClean`, and the clean
  trigger (`needsCoverageClean`) fires on micro-polygons. Loaded inputs
  (`match`, `code-update`, `change`, `extend`) also trigger on any
  enclosed hole, as topo-tools-py's `read_reproject_and_clean` does;
  `change` gains the input clean it lacked.
- Clip's output, Topology Cleaner's input and output, and the Package
  tools' input call `mergeMicroPolygons` directly. Detect reports
  micro-polygons unfixed.
- WASM GEOS threw "non-noded intersection" rebuilding 1 of 21 receiving
  features on NLD Clip. The rebuild falls back row by row, snapping the
  receiving feature onto its incoming micro parts, the pattern of
  [0036](0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md).
  Snapping the micro part onto the feature instead still threw.

## Consequences

- NLD Clip (topo-tools-py demo `schema-join` pair) writes 72 features with
  the same adm2 codes as Python. JS reports 197 micro-polygon rows to
  Python's 174, as the WASM clip's snap fallbacks cut slightly different
  slivers.
- Topology Cleaner merges micro-polygons without listing them in its
  issues panel, as topo-tools-py's `topo-clean` does.
- The any-hole input trigger adds a whole-layer union per loaded input.
