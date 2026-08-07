# 0013: Topology Cleaner skips ST_CoverageClean when the input already has no defects

## Status

Accepted

## Context

Topology Cleaner ran `ST_CoverageClean` unconditionally on every clean/reclean
call, regardless of whether `layer_01` actually had any topology violations.
The Python port (`topo-tools-py`) already gates this: when the input has no
overlaps/unmatched edges (`ST_CoverageInvalidEdges_Agg`) and no gap fill is
requested, there is nothing for `ST_CoverageClean` to do.

## Decision

Port the same gate: `buildClean` (`topology-cleaner/pipeline/clean.ts`)
copies `layer_01` straight into the target table when `gapDeg === 0` and the
cached `hasViolations` check (computed once per load, since `layer_01` is
static across reclean calls) is `false`, skipping `ST_CoverageClean`
entirely. `hasCoverageViolations` was extracted into the shared
`src/lib/db/coverageClean.ts` so Edge Extender's `gatedCoverageClean` and
this new skip-check share one implementation.

## Consequences

Beyond the speed win on already-clean inputs, this also matters for
robustness: `ST_CoverageClean`'s WASM-GEOS path has its own robustness edges
(see [0001](0001-precision-retry-mitigates-wasm-noding-failures.md)'s
Context) that get exercised more, the more often it's called on data that
didn't need it — the same reasoning behind Edge Extender's own input-clean
gate.
