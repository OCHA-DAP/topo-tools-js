# Stitch

Closes seams in an already-tiled polygon layer with one whole-table
`ST_CoverageClean` pass — for example tiles produced independently by Edge
Extender's per-group Voronoi extension (Edge Matcher) or a future per-parent
clip primitive. Once a layer's independently-computed tiles sit next to each
other, whatever seam disagreements remain between them get closed here.
Ported from topo-tools-py's `stitch` (`docs/explanation/stitch.md` there),
which extracted this exact operation out of `match`'s and (eventually)
`mosaic`'s own final merge stage into a standalone primitive.

## Pipeline

1. **Load** — the shared loader (`$lib/db/loader`), no pre-clean. Unlike
   `extend`, `stitch` does not run `gatedCoverageClean` on the input first:
   the input's seams are exactly what this tool exists to close, so
   pre-cleaning them would defeat the point.
2. **Clean** (`pipeline/index.ts`, via `$lib/db/coverageClean`'s
   `buildCoverageCleanEscalating`), one whole-table `ST_CoverageClean` pass
   starting at `SNAP_TOLERANCE` gap/snap, `preserveOriginal: true` so a
   feature that collapses to empty falls back to its pre-clean geometry
   rather than vanishing. If the pass still leaves invalid edges, the snap
   width widens by `SNAP_TOLERANCE` and retries, up to 9 additional
   attempts, before giving up and leaving whatever the last attempt
   produced. `SNAP_TOLERANCE` is a noise floor, not a real gap-closing
   width, see below for why a wider gap is left alone rather than filled.
3. **Issues** (`pipeline/issues.ts`, via `$lib/db/coverage`'s
   `gapRegionsQuery`) — any interior hole left in the cleaned output wider
   than `SNAP_TOLERANCE` gets a `kind='gap'` row (area, max width,
   thinness ratio), matching Topology Cleaner's issues-table column shape.
   `stitch` also checks the cleaned output for residual overlaps
   (`hasCoverageViolations`), which `ST_CoverageClean` should always
   remove — a true result there is logged as a warning, not raised, the
   same warn-only posture `extend`'s own validation sweep uses.

## Why SNAP_TOLERANCE, not a shape-based or configurable width

Topology Cleaner's Minimal/Thin/All modes exist because a user is looking
at one specific coverage and deciding how aggressively to fill its gaps.
`stitch` has no such judgment call to make: it is a mechanical seam-closer
run as one stage of a larger pipeline (or standalone against an
already-tiled file), so it always uses the same fixed noise-floor width.
A seam gap between two independently-computed tiles can be much wider than
`SNAP_TOLERANCE` — a genuine geometric disagreement between tiles, not
float noise — and `stitch` deliberately leaves those unfilled rather than
guessing at a fill width; the issues report exists so a human can decide
whether a leftover gap needs attention.

## Relationship to Topology Cleaner

Both tools wrap `ST_CoverageClean`, but for different jobs: Topology
Cleaner is an interactive tool for a single input a user is actively
inspecting, with adjustable gap-fill modes and a persisted fixed/unfixed
issues table across recleans. `stitch` is a one-shot, non-interactive pass
with no reclean loop and no "fixed" tracking — it reports what's left after
the single pass and stops. The two tools deliberately don't share pipeline
code beyond the primitives already common to both (`$lib/db/coverageClean`,
`$lib/db/coverage`, `$lib/db/units`).
