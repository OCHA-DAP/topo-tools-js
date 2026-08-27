# 0029: Code join wins on disagreement, falls back on no match

## Status

Accepted. Narrows [0026](0026-clip-scoped-to-single-assignment-group.md)'s
`match_column` exclusion: `clip` now supports the code-join override
described below. 0026's multi-file/`source_file` batch-mode exclusion is
unaffected and still stands.

## Context

`match`, `mosaic`, and `clip` all delegate parent assignment to
`src/lib/db/assignOne.ts` (assign-one, per file) or
`src/lib/tools/match/pipeline/assign.ts` (assign-many, per child), both
spatial-majority-vote only until now. topo-tools-py's equivalent shared
`core/assign` primitive accepts an optional code-join override
(`match_column` / `parent_match_column`+`child_match_column`): some
parent/child pairs carry a matching administrative-code column (e.g. a
pcode), a signal cheaper and often more reliable than spatial overlap, but
one that can be wrong exactly when a real boundary adjustment or a data
error has occurred on one side. See
[topo-tools-py ADR-0045](../../../topo-tools-py/docs/adr/0045-code-join-precedence-and-fallback.md)
for the full rationale; this ADR ports that decision to the JS app rather
than re-deriving it.

## Decision

`resolveMatchColumns`/`buildPerChildCodeWinners`/`pickFileCodeWinner`/
`resolveAssignment`/`combinePerChildAssignment` (new
`src/lib/db/codeJoin.ts`) implement the same rule Python's `core/assign`
does: when a caller supplies match columns, both signals are always
computed, an exact code join restricted to `(child, parent)` pairs that
already spatially overlap, and the existing spatial-majority vote. The code
result wins whenever one exists, even on disagreement
(`assignmentMethod: 'code'`, `spatialAgrees: false`, surfaced as
`kind='code-mismatch'`); a child (or, for assign-one, a whole file) with no
overlapping-parent code match falls back to the spatial result
(`assignmentMethod: 'spatial_fallback'`, `spatialAgrees: null`, surfaced as
`kind='code-fallback'`). Omitting the match columns keeps every existing
caller's behavior and output schema unchanged.

`assignOne` gains optional `parentMatchColumn`/`childMatchColumn`
parameters; `match`'s `computeAssignment` gains the same, evaluated per
child instead of per file. `clip` gains its first issues report
(`src/lib/tools/clip/pipeline/issues.ts`) as a direct consequence of
gaining this feature, since flagging a mismatch or fallback needs somewhere
to report it.

## Consequences

`match`, `mosaic`, and `clip` all gain the override through the shared
`codeJoin.ts` module rather than three separate implementations. `clip`'s
new issues report only carries `code-mismatch`/`code-fallback` rows (plus
its pre-existing `unassigned` dropped-child case); it has no `gap` kind,
since clip has no seam-closing pass. `clip`'s multi-file/`source_file`
batch mode remains out of scope per 0026, unaffected by this change, this
ADR narrows only the `match_column` exclusion clause, not the scoping
decision as a whole.

`mosaic`'s and `clip`'s assign-one is per-file, not per-child: a single
`assignmentMethod`/`spatialAgrees` outcome for the whole run is recorded,
and every assigned child in that run is flagged with the same issue kind
when the run's outcome is a mismatch or fallback, matching Python's stated
per-file behavior for `assign_one`.
