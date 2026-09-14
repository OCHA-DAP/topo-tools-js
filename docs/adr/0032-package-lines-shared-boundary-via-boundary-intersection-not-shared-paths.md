# 0032: `package-lines` builds shared boundaries from `ST_Boundary`/`ST_Intersection`, not a shared-paths function

## Status

Accepted. Ports
[topo-tools-py ADR-0097](../../../topo-tools-py/docs/adr/0097-package-lines-shared-boundary-via-boundary-intersection-not-shared-paths.md).

## Context

`package-lines` needs the geometry two adjacent admin units share along
their common edge. PostGIS has `ST_SharedPaths` for exactly this. DuckDB
WASM's spatial extension has neither `ST_SharedPaths` nor `ST_Relate`,
confirmed by querying `duckdb_functions()` for `%shared%`/`%relate%` against
the loaded extension: zero rows.

## Decision

Build the shared segment from primitives that do exist:
`ST_LineMerge(ST_Union_Agg(ST_CollectionExtract(ST_Intersection(boundary_part_a,
boundary_part_b), 2)))` per bbox-prefiltered, `ST_Touches`-confirmed
candidate pair, keeping only the `LineString`/`MultiLineString` component
(`ST_CollectionExtract`'s type `2`) and dropping the point-only
intersection a corner-only touch produces. The exterior edge per fid is
the remainder: `ST_LineMerge(ST_Difference(boundary_part,
COALESCE(own_shared_union, empty_multilinestring)))`.

The outer `ST_LineMerge` on the shared side is required, confirmed against
the real Gambia adm3 portolan file (115 admin3 units): `ST_Intersection` of
two boundary parts returns one fragment per matching edge segment, not one
merged line, even where both sides' vertex sequences exactly coincide.
Without it, one touching pair produces many unmerged fragments instead of
a single line (topo-tools-py's own finding, at real country scale, was 418
fragments from one pair). With the fix in place, the Gambia run produced
341 total rows (105 exterior + 236 shared) across 3 detected levels, with
every shared row carrying a plausible single-line geometry.

## Consequences

Two whole-boundary-part `ST_Intersection` calls per touching pair (shared)
plus one `ST_Difference` per fid (exterior) cost more than a single
`ST_SharedPaths` call would, but both operate on already bbox-prefiltered,
part-exploded, whole-fid-boundary inputs, never a global union operand,
matching this project's own anti-pattern rule for large collection
operands (`docs/adr/0001`).
