# Mosaic

Fits a children layer that is already the finished output of a prior Edge
Extender run into a new/different parent boundary, without re-running
Voronoi extension. A thin orchestrator chaining the same three primitives
this app exposes standalone: assign-one (`$lib/db/assignOne.ts`, shared
with Clip), clip (`$lib/db/clipEngine.ts`/`clipTiling.ts`, shared with
Clip), and stitch (`stitch/pipeline/index.ts`'s `runStitch`, called
directly with `mosaic`'s own already-clipped table in place of `stitch`'s
usual `layer_01`). Ported from topo-tools-py's `mosaic`.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load the children layer and the
   parent/clip layer raw, exactly like Clip: neither is coverage-checked
   or -cleaned first.
2. **Assign** (`$lib/db/assignOne.ts`) — the same assign-one majority vote
   Clip uses, at exactly the same single-children-file scope
   (`docs/adr/0026`, shared by both tools).
3. **Clip** (`$lib/db/clipEngine.ts`) — the same tiled clip Clip uses.
   Fails the run if zero output rows result.
4. **Stitch** (`stitch/pipeline/index.ts`'s `runStitch`, called with
   `sourceTable="cl_clip"`, `attrTable="child_layer_attr"`) — one
   whole-table `ST_CoverageClean` pass over the clipped result, closing
   seams between the (already-extended, but freshly-clipped-to-a-new-
   boundary) child pieces.
5. **Assemble issues** (`pipeline/issues.ts`) — combines every child that
   never reached the final output (kind `unassigned`, whichever stage
   dropped it: not overlapping the winner parent, or clipping to empty)
   with every leftover gap `runStitch`'s own issues check finds (kind
   `gap`), into one report.

## Why assign-one, not assign-many

Children here are assumed already extended (overshooting), which is
exactly the scenario assign-one (majority vote by count) is built to
survive and assign-many (per-child plurality, what Edge Matcher uses) is
vulnerable to — see `docs/explanation/clip.md`'s "Assign" section for the
full reasoning, identical here.

## No re-extension

Match's own per-group extension is the expensive part of that pipeline.
Mosaic skips it entirely on the assumption the children are already
extended, making it just assign + clip + stitch — useful when refitting an
existing Edge Extender output against a different or updated parent
boundary without redoing the Voronoi work.

## Warn-only, not a hard export gate

Unlike topo-tools-py's `mosaic`, which raises before export if the
stitched output still fails a topology check, this app's `mosaic`
reports a residual overlap or gap (via the issues download and a console
warning) without blocking export — see `docs/adr/0027` for why this
follows the same warn-only precedent `stitch` and Edge Extender already
use for their own post-clean invariant checks.
