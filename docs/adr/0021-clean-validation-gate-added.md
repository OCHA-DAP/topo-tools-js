# 0021: clean gains a hard-reject validation gate after ST_CoverageClean

## Status

Accepted

## Context

Topology Cleaner's only post-fix check was `verifyExport` — an informational
"export check" (row count, `ST_IsValid` sweep, residual gap/overlap count)
that never blocked anything; the tool always produced a "Fixed" view and
surfaced findings in a warning banner. This was a deliberate interactive-tool
choice, but it meant a genuinely corrupted `ST_CoverageClean` result — e.g. a
feature with no connection to any detected defect collapsing to nothing —
would still render as a normal, downloadable "Fixed" output, with only a
banner most users could miss.

The sister Python port hard-rejects (raises, produces no output) in exactly
this situation, via checks tuned against real portolan admin-boundary data:
an area floor anchored to the detected overlap area rather than a flat
fraction of dataset size (rejected in `topo-tools-py`'s
`docs/adr/0009-area-floor-anchored-to-overlap-area.md` — a flat fraction
couldn't distinguish "a big overlap in a small dataset" from real
corruption), a per-fid collapse check that exempts fids adjacent to a
detected defect, and a non-polygon geometry-type check.

## Decision

Port the same gate. `pipeline/validate.ts`'s `validateCleanOutput` runs
immediately after every real `ST_CoverageClean` call (both the initial
clean and every reclean), before the result is accepted, and throws if any
of: the output still has coverage violations; total area falls below
`inputArea*(1 - 0.02) - overlapArea*3.0`; a defect-unrelated fid collapsed
to empty; or any output geometry isn't Polygon/MultiPolygon. `buildClean`
writes `ST_CoverageClean`'s result to a scratch table first and only
promotes it to `tc_clean` after validation passes, so a rejected reclean
leaves the previous good `tc_clean` (and anything exporting straight from
it) untouched. Both existing error-handling paths — `runFromLoaded`'s
stage-4 `PipelineError` wrap and `recleanOnly`'s caller-side catch in
`App.svelte` — already handle a thrown error here correctly with no new UI
state needed.

The skip-gate branch (straight copy-through when there are no violations
and no gap to fill) never runs this gate — a copy can't fail these checks.
The pre-existing `verifyExport` export check is unchanged and stays purely
informational; it now sits downstream of a gate that's already filtered
out the worst outcomes.

## Consequences

`docs/reference/clean.md`'s Outputs section now documents two distinct
checks: this hard-reject gate, and the still-never-blocking export check.
A user who picks a gap-fill width (or hits an already-marginal input) that
fails these checks now sees an error and the previous result stays
displayed, instead of a silently-corrupted "Fixed" view.
