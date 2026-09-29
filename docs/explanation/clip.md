# Clip

Assigns an input layer to the one overlay feature it overlaps most (by
majority vote across every input feature, not per-input-feature), then clips every input feature
to exactly that overlay feature's boundary. Built for already-extended, overshooting
geometry — e.g. one country's admin units after Edge Extender — where a
per-input-feature assignment could be fooled by an input feature that overshoots into a
neighboring overlay feature's territory. Ported from topo-tools-py's `clip`; see
`docs/adr/0025` and `docs/adr/0026` for the two WASM/browser-specific
scoping decisions the port required.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load the input layer and the
   overlay layer independently via the shared loader, with no
   `gatedCoverageClean` on either: `clip` reports on and clips against the
   raw input, and any resulting seams are `stitch`'s job downstream.
2. **Assign** (`pipeline/assign.ts`, `assignOne`) — assign-one: every
   overlay feature's vote count is the number of _distinct input features_ it
   overlaps, not each input feature's own overlap area, so one input feature that
   overshoots deep into a neighboring overlay feature doesn't outvote the many
   input features correctly touching the real overlay feature. This differs from
   `match`'s assign-many (`docs/explanation/match.md`), which assigns each
   input feature independently to whichever overlay feature it overlaps most by area —
   correct for `match`'s raw/unextended geometry, but exploitable here by
   overshoot. The overlay feature boundary's parts are grid-tiled first if their
   vertex count exceeds `CLIP_TILE_MIN_VERTICES`, so input features are matched
   against bounding-box-nearby tiles instead of one huge polygon.
   Every input feature is assigned to the winner, including one that does
   not overlap it, as topo-tools-py's `assign_one` does (its ADR 0082).
3. **Clip** (`pipeline/engine.ts`, `clipEngine`), every input feature assigned to
   the winning overlay feature is intersected against that overlay feature's own geometry
   (tiled the same way as the assign stage), and any assigned input feature whose
   clip result comes out empty, including every one lying outside the
   winner, is dropped from the output. `pipeline/issues.ts` reports these
   as `clip-empty` rows with their pre-clip geometry; `unassigned` rows
   only arise when no overlay feature wins at all.

## Single winning overlay feature, no per-overlay-feature loop

topo-tools-py's `clip` can vote independently per source file and clip
against a per-fid loop of winner overlay features, each isolated in its own OS
subprocess. This app's DropZone has no per-file voting-group concept (see
`docs/adr/0026`): one input upload is one vote, producing exactly one
winner overlay feature every run. `assignOne` and `clipEngine` are written directly
against that single-winner shape — there is no per-source grouping and no
per-overlay-fid loop to isolate, so there's also no cached-tiles reuse
concern Python's multi-overlay design needs.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`overlayMatchColumn`/`inputMatchColumn` pair, `assignOne` also computes an
exact code join, restricted to `(input feature, overlay feature)` pairs that already
spatially overlap, alongside the majority vote above (per file, since
assign-one has no per-input-feature granularity: every input feature in the run shares one
`assignment_method`). The code result wins whenever one exists, even on
disagreement; a file whose code has no overlapping overlay match falls back
to the spatial result. This gives `clip` its first issues report
(`pipeline/issues.ts`, `buildClipIssues`), produced only when the override
is supplied and yields at least one `code-mismatch`/`code-fallback` row.
Ported from topo-tools-py's `core/assign`; see `docs/adr/0029` and
`docs/reference/shared.md` for the full contract, and
`src/lib/db/codeJoin.ts` for the shared implementation `match` and `mosaic`
also use.

## No process isolation needed

Python isolates each overlay feature's `ST_Intersection` call in a fresh OS
subprocess because repeated calls leak GEOS's native heap. A spike against
this app's WASM DuckDB build found no equivalent leak at the scales tested
(`docs/adr/0025`), so `clip` here calls `ST_Intersection` directly in the
shared connection, the same pattern every other tool in this codebase uses.

## Failure modes

- No input feature overlapping any overlay feature at all fails the run outright — see
  `assignOne`'s thrown error.
- A clipped result with zero output rows fails the run, surfaced as a
  pipeline error at the clip stage.
- Neither failure mode falls back to a partial or approximate result:
  `clip`'s output MUST always be geometrically real, or the run fails.
