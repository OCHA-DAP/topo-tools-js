# 0007: WASM GEOS noding non-determinism accepted, not chased further

## Status

Superseded by [0022](0022-noding-precision-retry-removed-for-python-parity.md)

## Context

Across two otherwise-identical runs with different candidate-list
densities, the *set* of groups that failed before retry differed: with a
narrow list (`[1e-8, 1e-7, 1e-6]`), Dolega and Chepigana failed while La
Pintada passed; with the full 28-value list, Dolega and Chepigana passed
while La Pintada failed. Per-fid isolated tests are deterministic (same
group, same input, run in isolation → same crash location every time), but
the real sequential batch is not — likely tied to WASM heap state carried
over from earlier groups in the same session. This was independently
reconfirmed at finer grain during the density experiment in
[0006](0006-precision-candidate-density-not-increased.md): a from-scratch
rerun on identical input produced a different pathological fid than the
original diagnosis run.

## Decision

Accept the non-determinism rather than pursue full run-to-run reproducibility.
The retry mechanism ([0001](0001-precision-retry-mitigates-wasm-noding-failures.md))
already tolerates it: whichever specific groups hit the pathological
condition on a given run, the multi-candidate sweep recovers them. No
attempt was made to pin down or eliminate the WASM heap-state dependency
itself.

## Consequences

Expect some run-to-run variance in exactly which groups would have needed a
retry, though the fixes above drove the actual observed failure rate to 0%
across every tested real-world batch. Treat the aggregate behavior (does the
retry mechanism recover all groups) as the meaningful signal, not any single
run's internal retry-count breakdown — a debugging session that isolates
"the one failing case" from a specific run may not reproduce with the exact
same fid on a later run of the same input.
