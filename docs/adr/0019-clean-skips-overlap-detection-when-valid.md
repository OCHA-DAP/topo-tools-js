# 0019: Skip overlap detection entirely when the input already has no violations

## Status

Accepted

## Context

`buildOverlapRegions`'s bbox-prefiltered O(n²) self-join ran unconditionally,
even when the input coverage already has no invalid edges — a case where it
can only ever find zero overlaps, since a coverage with no invalid edges
cannot contain an overlapping or nested pair either. The sister Python port
made the same observation and documented it in `topo-tools-py`'s
`docs/adr/0007-skip-overlap-detection-when-valid.md`, confirming the skip
cut a ~20 minute run on an already-clean 9,658-fid layer down to ~23s
(dominated by gap detection, which has no equivalent cheap existence check
and so still runs unconditionally).

## Decision

`buildOverlapRegions` now takes the already-cached `hasViolations` signal
(`inputHasViolations`, computed once per load in `clean.ts`/`index.ts` for
the `ST_CoverageClean` skip-gate) and writes an empty overlap-regions table
directly, without running the join, whenever it's `false`.

## Consequences

No behavior change on the result — an already-valid coverage always
reported zero overlaps anyway, just at O(n²) join cost. Gap detection is
unaffected and still runs unconditionally, matching the Python port's same
reasoning (no cheaper primitive exists for "are there any gaps").
