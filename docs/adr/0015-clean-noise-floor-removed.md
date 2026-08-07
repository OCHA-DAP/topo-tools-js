# 0015: Topology Cleaner's 1cm² noise floor removed after finding no jitter

## Status

Accepted

## Context

Topology Cleaner discarded any detected gap/overlap below `MIN_ISSUE_AREA_M2`
(1e-4 m², ~1cm²), sized to a float-jitter magnitude (up to 1.6e-7 m²)
observed on real failing datasets at the time the floor was added — a
magnitude tied to the precision-reduction retry that
[0014](0014-clean-precision-retry-removed.md) has since removed. The
Python port (`topo-tools-py`) independently ported this same floor from
this repo, then verified against its own native GEOS build that it found
zero floating-point artifacts and removed it there (see that repo's
`docs/adr/0010-noise-floor-removed-no-jitter-found.md`).

## Decision

Verified directly against this repo's actual `duckdb-wasm` build (Chile,
Philippines, Indonesia admin3; COD admin4 up to 9,658 fids), on both the
primary detection path and after `ST_ReducePrecision`, that no sub-cm²
floating-point artifacts occur — matching the Python port's finding on
native GEOS. Removed `MIN_ISSUE_AREA_M2` and its conversion helper
(`m2ToDegSq`, `topology-cleaner/pipeline/units.ts`) from both
`gapRegionsQuery` and `overlapRegionsQuery` (`topology-cleaner/pipeline/issues.ts`).

## Consequences

Topology Cleaner now reports every detected gap and overlap regardless of
size, same as the Python port. If a genuine sub-cm² artifact source
resurfaces (e.g. from a future change to how derived geometry is produced),
it would need independent re-verification rather than reinstating this
specific floor value, since the constant was never more than an empirical
match to a jitter source that no longer exists in this pipeline.
