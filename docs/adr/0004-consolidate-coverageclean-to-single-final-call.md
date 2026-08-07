# 0004: Consolidate output-side ST_CoverageClean to one call, at the true final output

## Status

Accepted

## Context

After [0002](0002-buildarea-dissolve-reverted-silent-area-loss.md)'s revert,
the `GAPS: N interior rings` warning still fired on 74/76 groups, with much
lower ring counts than before. Investigation in QGIS identified these as
genuine micro gaps/overlaps at fid seams. A gated `ST_CoverageClean` pass
(`gap=1e-6`, ~111mm — this investigation's established derived-geometry
ceiling) was added, reducing `GAPS` warnings from 74/76 groups to 15/76.

While implementing further call sites (a second pass post-clip on
`ge_group_clip`, plus a planned third on the final assembled `ge_results`,
to also catch cross-group seams), this was flagged as over-cleaning:
multiple gated-check calls per group, when only the *final* assembled state
actually matters for correctness. `ST_CoverageClean` fixes whatever the
geometry looks like at the moment it's called, so cleaning mid-pipeline only
pays off if leaving a defect uncleaned would compound into something worse
downstream — true for the area-loss bug in
[0002](0002-buildarea-dissolve-reverted-silent-area-loss.md), not true for a
coverage-wide seam gap.

## Decision

Exactly one gated `ST_CoverageClean` call per tool invocation, at the true
final output:
- **Edge Extender** (`/extend`): unchanged — still cleans `layer_05` once
  inside `runPipeline`, since for this tool (no group loop) that genuinely
  is the end for the no-clip case.
- **Edge Matcher** (`/match`): removed cleaning from inside the per-group
  `runPipeline` call entirely (`runPipeline(conn, onProgress, {
  skipOutputClean: true })`), and dropped the post-clip clean attempt.
  Added exactly one `gatedCoverageClean(conn, "ge_results", ...)` call in
  `match/pipeline/index.ts`, after all groups complete and the whole batch
  is assembled — the only point where cross-group seams can even be
  observed, since adjacent groups never share table state during the
  per-group loop.

## Consequences

Re-ran the full real batch: identical output to the 3-call-site version
(same 5 residual holed fids, same total-area match to floating-point
precision), at a fraction of the check overhead (1 gated check for the
whole batch instead of up to 152). Confirms cleaning at the true end only is
exactly as correct as cleaning at every intermediate step for this class of
defect. Not all 15 remaining residual holes turned out to be micro-scale —
see [0011](0011-near-miss-cross-group-edges-accepted-as-cosmetic.md).
