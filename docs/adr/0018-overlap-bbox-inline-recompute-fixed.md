# 0018: Overlap-detection bbox prefilter precomputed, not recomputed inline

## Status

Accepted

## Context

`overlapRegionsQuery` (Topology Cleaner) and Edge Extender's neighbor-union
self-join (`edge-extender/pipeline/lines.ts`) both called `ST_XMin`/`ST_XMax`/
`ST_YMin`/`ST_YMax` directly inside the JOIN's `ON` clause. The sister
Python port hit the identical anti-pattern and documented it in
`topo-tools-py`'s `docs/adr/0014-bbox-inline-recompute-in-join.md`: DuckDB
recomputes the envelope on every pairwise comparison instead of once per
row — invisible at small vertex counts, but a confirmed 57+ minute hang on
real Colombia admin3 data (20k-54k vertex polygons, the same class of file
present in this repo's portolan test catalog). `edge-extender/pipeline/merge.ts`
already avoided this correctly by precomputing bbox columns in a CTE before
its self-join, giving a working reference pattern already in this codebase.

## Decision

Precompute `xmin`/`xmax`/`ymin`/`ymax` as real columns in a CTE (or on the
narrow tmp table itself, for `lines.ts`) before joining, and reference the
columns — never the function calls — in `ON`. Applied to both call sites:
`topology-cleaner/pipeline/issues.ts`'s `overlapRegionsQuery` and
`edge-extender/pipeline/lines.ts`'s neighbor-union join.

## Consequences

Same query semantics, no behavior change — this is a perf/hang fix only.
Any future bbox-prefiltered join in this codebase must follow the same
precompute-then-reference pattern; `merge.ts`'s CTE shape is the reference
to copy.
