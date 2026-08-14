# 0001: Precision-reduction retry mitigates WASM-only GEOS noding failures

## Status

Superseded by [0022](0022-noding-precision-retry-removed-for-python-parity.md)

## Context

Running Edge Matcher on real admin-boundary data (Panama: 76 groups) failed
~18% of groups (14/76) with `TopologyException: found non-noded intersection
between LINESTRING (...) and LINESTRING (...)`. Confirmed via native `duckdb`
CLI reproduction that this does not happen natively — same GEOS version
family, same SQL, same input, native succeeds every time. This is a
WASM-build-specific GEOS floating-point robustness issue.

Fully diagnosed one case (Changuinola → Valle del Risco, Panama adm3): the
Voronoi cell computed for a unit can drift by single-digit millimeters to a
few meters from that same unit's own original boundary, at the exact point
where they're supposed to coincide. GEOS's noding step throws when a later
operation has to resolve that near-but-not-quite-coincident seam.

Two fixes were tried and rejected before landing on the retry approach:
making the input-side `ST_CoverageClean` gate unconditional (made it worse,
2→15 failures — `ST_CoverageClean` itself has WASM robustness edges that
firing it more often exercises more); and a single fixed
`ST_ReducePrecision` value on real input (worked at 2e-4/~22m for
Changuinola, but that's a visible-scale accuracy cost on real boundary
data). Precision-reduction was also confirmed **not** a monotonic
"coarser is safer" knob: for Valle del Risco, 11mm and 33mm both failed but
16.7–27.8mm in between succeeded, and separately 111mm also succeeded — no
clean threshold, just scattered working values, replicated at finer
granularity across a later 155-value sweep (see
[0006](0006-precision-candidate-density-not-increased.md)).

## Decision

Extract a shared retry helper, `withNodingRetry` (`src/lib/db/precisionRetry.ts`),
exporting a 28-candidate list (`NODING_RETRY_PRECISIONS`, 0.1mm–111mm: every
1–9× step within `{1e-9, 1e-8, 1e-7}` plus `1e-6`). Callers apply each
candidate's `ST_ReducePrecision` to whichever table carries the suspected
pathological vertices — always the algorithmically-*derived* side of an
operation (e.g. Voronoi-generated geometry), never real input data — and
stop at the first candidate that succeeds. The value of the loop is having
several independent candidates to try, not the specific spacing: a single
unlucky exact-coincidence miss at one candidate doesn't stop the pipeline.

Applied to `stageMerge`'s final per-fid dissolve (`edge-extender/pipeline/merge.ts`).

## Consequences

Real Panama batch: 18% → 7.9% failure rate (14/76 → 6/76) from this fix
alone. The remaining 6 failures were a second, separate bug in the group
clip step — see [0003](0003-group-clip-needs-its-own-precision-retry.md).
Because the retry only ever reduces precision on derived/algorithmic
geometry, even the coarsest candidate never costs real-world accuracy
beyond what that derivation step already introduced.
