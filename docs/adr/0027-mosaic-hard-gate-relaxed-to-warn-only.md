# 0027: `mosaic`'s hard topology gate relaxed to warn-only

## Status

Accepted

## Context

topo-tools-py's `mosaic` MUST pass a `check_valid_topology()` hard gate
(raising, blocking export) on its final stitched output before writing
anything. This app has no existing precedent for a gate that actually
raises: `stitch`'s own post-`ST_CoverageClean` residual-gap check
(`src/lib/tools/stitch/pipeline/index.ts`) only warns and still exports,
and Edge Extender's `runValidation` (`edge-extender/pipeline/index.ts`)
does the same for its own post-merge overlap/gap checks — both treat a
residual defect after a clean pass that's supposed to remove it as a
"shouldn't happen, but don't destroy the user's work over it" situation,
surfaced via `console.warn` and (for `stitch`) an issues-report download,
not a thrown error.

## Decision

`mosaic` follows this app's existing warn-only precedent rather than
introducing the first true raising hard gate: a residual overlap or a
leftover gap after its stitch pass is reported (via `console.warn` and the
issues report, exactly like `stitch`'s own pattern, which `mosaic` calls
directly) but does not block export.

## Consequences

A `mosaic` run always produces its stitched output once assign and clip
succeed, even if the final coverage isn't perfectly clean. This matches
every existing "post-clean invariant check" in this codebase and avoids
mosaic being the sole exception with different failure semantics for
what is, on this app's own precedent, the same class of event (a
`ST_CoverageClean` pass that didn't fully close everything). If this
precedent is ever revisited codebase-wide (e.g. adding a real raising
gate to `stitch`/`extend`/`match` too), `mosaic` should be revisited to
match at the same time, not treated as an isolated exception now.
