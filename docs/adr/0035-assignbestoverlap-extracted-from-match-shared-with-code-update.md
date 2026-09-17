# 0035: `assignBestOverlap` extracted from `match`'s assign stage, shared with `code-update`'s reparent stage

## Status

Accepted.

## Context

`match/pipeline/assign.ts`'s `computeAssignment` inlined a "rank each
child's overlap pairs, keep the best" pattern
(`ROW_NUMBER() OVER (PARTITION BY a_fid ORDER BY shared_area DESC)`) to
assign each child to its single best-overlapping parent. `code-update`'s
reparent stage needs the identical per-child-best-overlap logic, to
re-derive each NEW unit's true current parent spatially at every level
finer than the coarsest, since a raw embedded parent column goes stale
exactly when the coarser unit was itself split, merged, or relocated.

## Decision

Extracted the inlined block into `$lib/db/assignBestOverlap.ts`
(`assignBestOverlap(conn, childTable, parentTable, pairsTable,
outputTable)`), documented in `docs/reference/shared.md`'s "Best-overlap
plurality pick" section. `match/pipeline/assign.ts` calls it in place of
its own inlined block; `code-update`'s `reparent.ts` calls it directly
against each level's NEW-side dissolved child/parent tables.

## Consequences

`match`'s own assignment behavior is unchanged; a child with zero
overlapping parents is still absent from the output table entirely,
never assigned a null parent. Per this repo's `CLAUDE.md` code-reuse rule,
this is a consolidation of already-proven, already-used logic, not a new
layer of indirection built for a hypothetical future need.
