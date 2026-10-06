# 0053: Notch detection buffers one segment at a time and grids its blobs

## Status

Accepted. Diverges from the SQL of topo-tools-py's `detect_notches` and
`close_notches` (py ADR 0132), not from their results.

## Context

py measures how far each unshared boundary segment runs close to a
neighbouring unit by unioning that unit's nearby segments into one line,
buffering it by `NOTCH_SPACING / 8` and intersecting. It then groups the
close-running pieces into notches by unioning their `NOTCH_SPACING * 1.5`
buffers. Both steps run unchanged in native DuckDB. In DuckDB-WASM
(`@duckdb/duckdb-wasm` 1.33.1-dev65.0) on the NLD edge demo input, the first
throws `TopologyException: depth mismatch` buffering a two-segment, nearly
collinear line, and the second throws a non-noded intersection unioning the
buffers. Each failure aborts the whole notch query.

## Decision

`_notch_near` buffers each nearby segment on its own, turns each
intersection with the unshared segment into an interval along it
(`ST_LineLocatePoint`), merges overlapping intervals per segment and unit,
and rebuilds the piece with `ST_LineSubstring`. Buffering distributes over
union, so the length matches py's. `_notch_runs` reduces each piece buffer
to the `NODING_FALLBACK_GRID` (1e-11 degrees) before the union. Both run on
every input, with no try-native-first fallback.

## Consequences

Run natively on the edge demo, the interval form matches py's query on all
438 segment and unit rows to within 2.5e-11 degrees. In the browser, the
topo demo gives py's 12 notches with the same unit pairs and scores to 4
decimals, and the edge demo gives py's single notch, which Edge Matcher
closes. The gridding moves blob outlines by at most about 1 µm, which is
negligible for 33 m grouping buffers. A future py change to these queries
has to be ported by hand, not copied.
