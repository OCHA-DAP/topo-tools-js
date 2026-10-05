# Mosaic

Fits an input layer that is already the finished output of a prior Edge
Extender run into a new/different overlay polygon boundary, without re-running
Voronoi extension. A thin orchestrator chaining the same three primitives
this app exposes standalone: assign-one (`$lib/db/assignOne.ts`, shared
with Clip), clip (`$lib/db/clipEngine.ts`/`clipTiling.ts`, shared with
Clip), and stitch (`stitch/pipeline/index.ts`'s `runStitch`, called
directly with `edge-mosaic`'s own already-clipped table in place of `edge-stitch`'s
usual `layer_01`). Ported from topo-tools-py's `edge-mosaic`.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load the input layer and the
   overlay layer raw, exactly like Clip: neither is coverage-checked
   or -cleaned first.
2. **Assign** (`$lib/db/assignOne.ts`), the same assign-one majority vote
   Clip uses, at exactly the same single-input-file scope
   (`docs/adr/0026`, shared by both tools). If overlay columns were
   requested, they're joined under their own names from the winning
   overlay polygon's own attribute row onto `input_layer_attr` here, before clipping.
3. **Clip** (`$lib/db/clipEngine.ts`) — the same tiled clip Clip uses,
   followed by the same clip-detached merge against the optional original
   layer (`docs/explanation/edge-clip.md`). Fails the run if zero output
   rows result.
4. **Stitch** (`stitch/pipeline/index.ts`'s `runStitch`, called with
   `sourceTable="cl_clip"`, `attrTable="input_layer_attr"`) — one
   whole-table `ST_CoverageClean` pass over the clipped result, closing
   seams between the (already-extended, but freshly-clipped-to-a-new-
   boundary) input polygon pieces.
5. **Assemble issues** (`pipeline/issues.ts`), combines every input polygon that
   never reached the final output (kind `clip-empty` for one clipped to
   nothing, including every one outside the winner overlay polygon, or
   `unassigned` when no overlay polygon won)
   with every merged or kept clip-detached piece (kind `detached-part`),
   every leftover gap `runStitch`'s own issues check finds (kind
   `gap`) and any `code-mismatch`/`code-fallback` rows from an optional
   code-based assignment override (same override Clip's assign-one
   accepts, see `docs/explanation/edge-clip.md`), into one report.

## Why assign-one, not assign-many

Input polygons here are assumed already extended (overshooting), which is
exactly the scenario assign-one (majority vote by count) is built to
survive and assign-many (per-input-polygon plurality, what Edge Matcher uses) is
vulnerable to — see `docs/explanation/edge-clip.md`'s "Assign" section for the
full reasoning, identical here.

## No re-extension

Match's own per-group extension is the expensive part of that pipeline.
Mosaic skips it entirely on the assumption the input polygons are already
extended, making it just assign + clip + stitch — useful when refitting an
existing Edge Extender output against a different or updated overlay polygon
boundary without redoing the Voronoi work.

## Warn-only, not a hard export gate

Unlike topo-tools-py's `edge-mosaic`, which raises before export if the
stitched output still fails a topology check, this app's `edge-mosaic`
reports a residual overlap or gap (via the issues download and a console
warning) without blocking export — see `docs/adr/0027` for why this
follows the same warn-only precedent `edge-stitch` and Edge Extender already
use for their own post-clean invariant checks.
