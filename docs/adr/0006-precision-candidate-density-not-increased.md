# 0006: Precision-candidate list density left unchanged after an empirical sweep

## Status

Accepted

## Context

After the tiered retry ([0005](0005-tiered-retry-reduces-both-sides-as-fallback.md))
landed, two follow-up questions were raised: how much precision reduction is
actually being applied, and whether a denser/fractional candidate list (not
just integer multiples of decades) would do meaningfully better than the
current 28-value list.

Built a 155-candidate list spanning 5 decades (`1e-9` to `1e-5`) × 31
multiples per decade (integers 1–9.5 plus fractions: halves, thirds,
quarters, etc.), tested against the reproducible whole-dataset monolithic
merge failure. A methodological trap surfaced first: rerunning the pipeline
from scratch on the identical input produced a *different* pathological fid
than the original diagnosis — direct evidence the Voronoi diagram output is
not bit-stable across separate runs on the same input (see
[0007](0007-noding-non-determinism-accepted-not-chased.md)), so "the known
failing case" is a moving target, not a fixed fixture.

Result of the actual density sweep (155 candidates × 2 modes, on the
isolated pathological fid): derived-only, 154/155 passed — the single
failure (`8e-9`) had both immediate neighbors (`7.5e-9`, `8.5e-9`) pass, no
cluster, no trend by decade or integer-vs-fractional multiplier. Both-sides
mode: 155/155 passed, matching [0005](0005-tiered-retry-reduces-both-sides-as-fallback.md)'s
original finding.

## Decision

Leave `NODING_RETRY_PRECISIONS` (`src/lib/db/precisionRetry.ts`) unchanged
at its original 28-value list. The failure signature is a single-point,
needle-in-a-haystack floating-point coincidence at one specific rounding
grid, not a systematic region of instability that a finer or differently-
spaced grid would avoid. The value of the retry loop is having *several*
independent candidates to try, not the specific spacing or density of those
candidates.

## Consequences

No code change. This validates the existing candidate list as already
adequate rather than under-provisioned, and forecloses "make the list
denser" as a future lever for reducing residual noding-crash risk.
