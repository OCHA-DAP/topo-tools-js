# 0022: Noding precision-reduction retry removed from Edge Extender/Edge Matcher

## Status

Accepted. Supersedes [0001](0001-precision-retry-mitigates-wasm-noding-failures.md),
[0003](0003-group-clip-needs-its-own-precision-retry.md),
[0005](0005-tiered-retry-reduces-both-sides-as-fallback.md),
[0006](0006-precision-candidate-density-not-increased.md), and
[0007](0007-noding-non-determinism-accepted-not-chased.md).

## Context

A line-by-line comparison against the sister Python port (`topo-tools-py`)
found that its `extend`/`match` merge and clip steps have no retry of any
kind: a GEOS noding failure there just raises, dropping the affected
group. JS's equivalent steps instead ran a 28-candidate (up to 56 with the
tiered fallback) `ST_ReducePrecision` sweep, recovering from the same class
of failure that Python treats as fatal.

Separately, Python's merge step (`_05_merge.py`) snaps the Voronoi cell onto
its neighbor union with `ST_Snap` before differencing — a fix at the source
of the noding mismatch. JS's merge step had no equivalent snap, relying
entirely on the retry to recover after the fact.

Given the choice to bring JS's behavior in line with Python's rather than
keep JS's extra recovery machinery, both differences are addressed together:
adding the snap (which reduces how often a noding failure would occur in the
first place) and removing the retry (accepting that a failure recovery-tier
no longer exists, matching Python).

## Decision

Remove `withNodingRetry`/`NODING_RETRY_PRECISIONS` (`src/lib/db/precisionRetry.ts`,
deleted) and its two call sites: `stageMerge`'s dissolve
(`edge-extender/pipeline/merge.ts`) and `clipToBoundary`
(`src/lib/db/clipToBoundary.ts`). Both now run their `ST_Intersection`/`ST_Difference`
once. `stageMerge` gains the `ST_Snap(cell, neighbor_union, SNAP_TOLERANCE)`
step Python already had, in place of the removed `ST_ReducePrecision` retry.

## Consequences

A GEOS noding failure in the merge or clip step now drops the affected
group (Edge Matcher) or fails the run (plain Edge Extender), the same as
Python, rather than being recovered by a precision-reduced retry. The `ST_Snap`
addition is expected to reduce how often this class of failure occurs at all,
per Python's own stated rationale for the snap, but does not eliminate it —
unlike the retry it replaces, which recovered unconditionally regardless of
cause. This is a deliberate acceptance of Python's fragility profile in
exchange for identical behavior between the two ports, not a claim that the
new behavior is more robust than what it replaces.
