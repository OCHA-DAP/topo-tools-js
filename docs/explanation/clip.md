# Clip

Assigns a children layer to the one parent unit it overlaps most (by
majority vote across every child, not per-child), then clips every child
to exactly that parent's boundary. Built for already-extended, overshooting
geometry — e.g. one country's admin units after Edge Extender — where a
per-child assignment could be fooled by a child that overshoots into a
neighboring parent's territory. Ported from topo-tools-py's `clip`; see
`docs/adr/0025` and `docs/adr/0026` for the two WASM/browser-specific
scoping decisions the port required.

## Pipeline

1. **Load** (`pipeline/load.ts`) — load the children layer and the
   parent/clip layer independently via the shared loader, with no
   `gatedCoverageClean` on either: `clip` reports on and clips against the
   raw input, and any resulting seams are `stitch`'s job downstream.
2. **Assign** (`pipeline/assign.ts`, `assignOne`) — assign-one: every
   parent unit's vote count is the number of *distinct children* it
   overlaps, not each child's own overlap area, so one child that
   overshoots deep into a neighboring parent doesn't outvote the many
   children correctly touching the real parent. This differs from
   `match`'s assign-many (`docs/explanation/match.md`), which assigns each
   child independently to whichever parent it overlaps most by area —
   correct for `match`'s raw/unextended geometry, but exploitable here by
   overshoot. The parent boundary's parts are grid-tiled first if their
   vertex count exceeds `CLIP_TILE_MIN_VERTICES`, so children are matched
   against bounding-box-nearby tiles instead of one huge polygon.
3. **Clip** (`pipeline/engine.ts`, `clipEngine`), every child assigned to
   the winning parent is intersected against that parent's own geometry
   (tiled the same way as the assign stage), and any assigned child whose
   clip result comes out empty is dropped from the output. `pipeline/issues.ts`
   reports these two drop reasons as distinct kinds, `unassigned` for a
   child that never overlapped the winning parent at all and `clip-empty`
   for one that was assigned but whose intersection came out empty, since
   they point at different causes.

## Single winner parent, no per-parent loop

topo-tools-py's `clip` can vote independently per source file and clip
against a per-fid loop of winner parents, each isolated in its own OS
subprocess. This app's DropZone has no per-file voting-group concept (see
`docs/adr/0026`): one children upload is one vote, producing exactly one
winner parent every run. `assignOne` and `clipEngine` are written directly
against that single-winner shape — there is no per-source grouping and no
per-parent-fid loop to isolate, so there's also no cached-tiles reuse
concern Python's multi-parent design needs.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`parentMatchColumn`/`childMatchColumn` pair, `assignOne` also computes an
exact code join, restricted to `(child, parent)` pairs that already
spatially overlap, alongside the majority vote above (per file, since
assign-one has no per-child granularity: every child in the run shares one
`assignment_method`). The code result wins whenever one exists, even on
disagreement; a file whose code has no overlapping-parent match falls back
to the spatial result. This gives `clip` its first issues report
(`pipeline/issues.ts`, `buildClipIssues`), produced only when the override
is supplied and yields at least one `code-mismatch`/`code-fallback` row.
Ported from topo-tools-py's `core/assign`; see `docs/adr/0029` and
`docs/reference/shared.md` for the full contract, and
`src/lib/db/codeJoin.ts` for the shared implementation `match` and `mosaic`
also use.

## No process isolation needed

Python isolates each parent's `ST_Intersection` call in a fresh OS
subprocess because repeated calls leak GEOS's native heap. A spike against
this app's WASM DuckDB build found no equivalent leak at the scales tested
(`docs/adr/0025`), so `clip` here calls `ST_Intersection` directly in the
shared connection, the same pattern every other tool in this codebase uses.

## Failure modes

- No child overlapping any parent unit at all fails the run outright — see
  `assignOne`'s thrown error.
- A clipped result with zero output rows fails the run, surfaced as a
  pipeline error at the clip stage.
- Neither failure mode falls back to a partial or approximate result:
  `clip`'s output MUST always be geometrically real, or the run fails.
