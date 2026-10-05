# Clip

Assigns an input layer to the one overlay polygon it overlaps most (by
majority vote across every input polygon, not per-input-polygon), then clips every input polygon
to exactly that overlay polygon's boundary. Built for already-extended, overshooting
geometry — e.g. one country's admin units after Edge Extender — where a
per-input-polygon assignment could be fooled by an input polygon that overshoots into a
neighboring overlay polygon's territory. Ported from topo-tools-py's `edge-clip`; see
`docs/adr/0025` and `docs/adr/0026` for the two WASM/browser-specific
scoping decisions the port required.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load the input layer and the
   overlay layer independently via the shared loader, with no
   `gatedCoverageClean` on either: `edge-clip` reports on and clips against the
   raw input, and any resulting seams are `edge-stitch`'s job downstream.
2. **Assign** (`pipeline/assign.ts`, `assignOne`) — assign-one: every
   overlay polygon's vote count is the number of _distinct input features_ it
   overlaps, not each input polygon's own overlap area, so one input polygon that
   overshoots deep into a neighboring overlay polygon doesn't outvote the many
   input polygons correctly touching the real overlay polygon. This differs from
   `edge-match`'s assign-many (`docs/explanation/edge-match.md`), which assigns each
   input polygon independently to whichever overlay polygon it overlaps most by area —
   correct for `edge-match`'s raw/unextended geometry, but exploitable here by
   overshoot. The overlay polygon boundary's parts are grid-tiled first if their
   vertex count exceeds `CLIP_TILE_MIN_VERTICES`, so input polygons are matched
   against bounding-box-nearby tiles instead of one huge polygon.
   Every input polygon is assigned to the winner, including one that does
   not overlap it, as topo-tools-py's `assign_one` does (its ADR 0082).
3. **Clip** (`pipeline/engine.ts`, `clipEngine`), every input polygon assigned to
   the winning overlay polygon is intersected against that overlay polygon's own geometry
   (tiled the same way as the assign stage), and any assigned input polygon whose
   clip result comes out empty, including every one lying outside the
   winner, is dropped from the output. `pipeline/issues.ts` reports these
   as `clip-empty` rows with their pre-clip geometry; `unassigned` rows
   only arise when no overlay polygon wins at all. Detached pieces are then
   merged or kept (below), and micro-polygons merged.

## Clip-detached pieces

Clipping an extended polygon to its overlay polygon can cut one of its parts
into several pieces, e.g. where the overlay edge crosses a thin tip.
`mergeDetachedParts` (`$lib/db/coverage.ts`, shared with `edge-mosaic` and
`edge-match` through `mergeClipDetached` and the per-group clip) groups each
piece by the pre-clip part holding its interior point and keeps that part's
largest piece on the original footprint. A piece under 1% of it merges into
the neighbour it shares the longest edge with, unless the original drew it
that way: mostly original land, with almost no original land clipped away
beside it. `edge-match` uses its pre-extension input as the original;
`edge-clip` and `edge-mosaic` need the optional original layer, and without it
only report such pieces. A piece with no edge neighbour is never changed and
isn't reported. Every JS clip runs against one overlay polygon, so the
same-overlay neighbour rule holds without an overlay column. See
`docs/adr/0042` and topo-tools-py's ADR 0120 for why the rule is a ratio
checked against the original, with no absolute size limit.

## Single winning overlay polygon, no per-overlay-polygon loop

topo-tools-py's `edge-clip` can vote independently per source file and clip
against a per-fid loop of winner overlay polygons, each isolated in its own OS
subprocess. This app's DropZone has no per-file voting-group concept (see
`docs/adr/0026`): one input upload is one vote, producing exactly one
winner overlay polygon every run. `assignOne` and `clipEngine` are written directly
against that single-winner shape — there is no per-source grouping and no
per-overlay-fid loop to isolate, so there's also no cached-tiles reuse
concern Python's multi-overlay design needs.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`overlayMatchColumn`/`inputMatchColumn` pair, `assignOne` also computes an
exact code join, restricted to `(input polygon, overlay polygon)` pairs that already
spatially overlap, alongside the majority vote above (per file, since
assign-one has no per-input-polygon granularity: every input polygon in the run shares one
`assignment_method`). The code result wins whenever one exists, even on
disagreement; a file whose code has no overlapping overlay match falls back
to the spatial result. This gives `edge-clip` its first issues report
(`pipeline/issues.ts`, `buildClipIssues`), produced only when the override
is supplied and yields at least one `code-mismatch`/`code-fallback` row.
Ported from topo-tools-py's `core/assign`; see `docs/adr/0029` and
`docs/reference/shared.md` for the full contract, and
`src/lib/db/codeJoin.ts` for the shared implementation `edge-match` and `edge-mosaic`
also use.

## No process isolation needed

Python isolates each overlay polygon's `ST_Intersection` call in a fresh OS
subprocess because repeated calls leak GEOS's native heap. A spike against
this app's WASM DuckDB build found no equivalent leak at the scales tested
(`docs/adr/0025`), so `edge-clip` here calls `ST_Intersection` directly in the
shared connection, the same pattern every other tool in this codebase uses.

## Failure modes

- No input polygon overlapping any overlay polygon at all fails the run outright — see
  `assignOne`'s thrown error.
- A clipped result with zero output rows fails the run, surfaced as a
  pipeline error at the clip stage.
- Neither failure mode falls back to a partial or approximate result:
  `edge-clip`'s output MUST always be geometrically real, or the run fails.
