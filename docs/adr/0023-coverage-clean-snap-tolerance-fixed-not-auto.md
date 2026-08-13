# 0023: ST_CoverageClean's snapping tolerance defaults to SNAP_TOLERANCE, not GEOS auto

## Status

Accepted

## Context

A line-by-line comparison against the sister Python port (`topo-tools-py`)
found that every `ST_CoverageClean` call in this repo (extend's input-clean
gate and merge finalization, match's parent/child pre-clean and final
whole-batch clean, clean's own fix stage) defaulted the snapping tolerance to
GEOS's own auto-computed value (`-1` in `runCoverageClean`'s options, which
GEOS resolves to `dataset_diameter / 1e8`).

Python tested that auto-default directly (its own ADR-0002/0029/0032/0040)
and found it swings from measurably too tight on small territories (a real
6.5x-undershoot case) to measurably too loose on a global mosaic (~400m snap
on real data, an active corruption risk of merging unrelated nearby
features). Python replaced it everywhere with a single fixed constant,
`SNAP_TOLERANCE`, and explicitly rejected re-adding an "auto" mode as a named
option.

## Decision

`runCoverageClean`'s (`src/lib/db/coverageClean.ts`) default `snap` now
resolves to `SNAP_TOLERANCE` instead of `-1`. `-1` remains a valid explicit
override for any caller that wants GEOS's own auto-computed tolerance, but no
call site uses it: `topology-cleaner/pipeline/clean.ts`'s clean stage, which
previously passed `snap: -1` explicitly, now uses the default.

## Consequences

Every `ST_CoverageClean` call in the repo now snaps at a single fixed
~1.1mm-equivalent tolerance regardless of dataset extent, matching Python.
This is a behavior-contract change for `clean`'s fix stage specifically
(`docs/reference/clean.md`) — small/large real-world datasets will see a
tighter or looser snap than before, respectively, and any output that
depended on GEOS's extent-relative auto-tolerance will differ slightly.
ADR-0008's finding that "an explicit snap tolerance instead of auto" didn't
help match's whole-batch WASM OOM ceiling still holds: that finding was about
memory behavior at OOM scale, not numeric correctness, and a fixed
`SNAP_TOLERANCE` is tighter (cheaper) than GEOS's auto value tends to be on
large datasets, so it does not reintroduce that risk.
