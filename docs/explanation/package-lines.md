# Package Lines

`package-lines` produces one deduplicated line network of admin
boundaries, tagged by adjacency and the coarsest admin level each segment
belongs to. A row is shared between two units when its `b_*` columns are
populated, and exterior to all of them when they're `NULL`; there is no
separate boundary-type column. A web map can style or filter
international vs. sub-national boundaries from this one layer, instead of
drawing every level's own polygon outline on top of each other. Ported
from topo-tools-py's `package-lines`.

## Why not a shared-paths function

PostGIS exposes `ST_SharedPaths` for exactly this shared-boundary
extraction. DuckDB WASM's spatial extension has neither `ST_SharedPaths`
nor `ST_Relate` (see `docs/adr/0032`). `package-lines` instead builds
shared boundaries from `ST_Boundary` plus `ST_Intersection` plus
`ST_CollectionExtract`.

## Pipeline (`pipeline/boundaries.ts`'s `buildBoundaries`)

1. Dissolve the input once, at the finest detected level only (via
   `package-polygons/pipeline/dissolveCore.ts`'s `runDissolveCore`); every
   coarser boundary is already contained in the finest level's own
   adjacency, so no per-level repeat is needed.
2. Build a part-exploded bbox table (`UNNEST(ST_Dump(geom))`, bbox columns
   from `$lib/db/bbox.ts`'s `bboxColumnsSql`, precomputed in a CTE rather
   than called inline inside a `JOIN`'s `ON` clause), so a multi-part fid
   with a remote exclave doesn't make every candidate-pair bbox comparison
   span the whole fid's extent.
3. Find candidate touching fid pairs from bbox overlap at the part level
   (`DISTINCT`, `a.fid < b.fid`), then confirm real adjacency with
   `ST_Touches` against each pair's whole-fid geometry.
4. For each touching pair, compute the shared segment as
   `ST_LineMerge(ST_Union_Agg(ST_CollectionExtract(ST_Intersection(boundary_part_a,
   boundary_part_b), 2)))`, filtering out `NULL`/empty results; a
   corner-only touch has `ST_Touches` true but an empty intersection, and
   produces zero shared rows for that pair. The outer `ST_LineMerge` is
   required even when both sides' vertices exactly coincide along the
   shared edge: `ST_Intersection` on two boundary parts returns one
   fragment per matching edge segment, not one merged line (see
   `docs/adr/0032`).
5. Union each fid's own shared segments via `ST_Union_Agg`, then compute
   its exterior as `ST_LineMerge(ST_Difference(boundary_part,
   COALESCE(own_shared_union, empty_multilinestring)))`, dumped to atomic
   `LineString` rows.
6. Classify every row: a shared row's depth is the coarsest detected level
   at which its two sides' own code columns first differ (walking
   coarsest to finest); an exterior row's depth is `min(levels) - 1`, one
   level coarser than the coarsest detected level, not hardcoded `0`,
   since `levels` can include a genuine level 0 for a multi-country file
   whose admin0 codes vary.
7. Raise if any finest-level fid is absent from every output row (as
   `left_fid` or `right_fid`), catching a fid silently dropped somewhere
   in the pipeline (`checkEveryFidPresent`).
8. Resolve each side's `fid` to the finest level's own detected identity
   families (`groupFamiliesByLevel`/`levelFamilyNames`, the same
   naming-anchor mechanism `package-points` uses, or an explicit schema's
   fixed `code`/`name`), one column pair per family under `a_*`/`b_*`
   (e.g. `a_pcode`/`b_pcode`), then drop `left_fid`/`right_fid` from the
   final output.

`depthColumn` is checked up front against the tool's own fixed output
column names (`left_fid`, `right_fid`, `geom`), raising before any query
runs rather than letting DuckDB silently rename a duplicate.
