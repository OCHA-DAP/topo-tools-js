# 0034: `code-update` reads `stageClassify`'s output tables directly per level, not its in-memory return value

## Status

Accepted.

## Context

`code-update` calls `polygon-changelog`'s `stageClassify` once per admin
level, reusing its overlap/classification engine unmodified. `stageClassify`
both writes its results to fixed table names (`cw_pairs_classified`,
`cw_polygon_class`) and returns an in-memory `{pairs, singletons}` value.
Threading that return value through `classifyLevel` into `assignLevel`
would require a level-parameterized wrapper type carrying `stageClassify`'s
own result shape across a function boundary it wasn't designed for.

## Decision

`assignLevel` queries `cw_pairs_classified` (for `a_fid`, `b_fid`,
`match_method`) and `cw_polygon_class` (for `side`, `fid`, `cluster_id`,
`relationship_class`) directly via SQL, reconstructing per-cluster
`{aFids, bFids, class}` groupings itself. This is safe only because
`assignLevel(n)` always runs immediately after `classifyLevel(n)` in the
same per-level loop iteration, before the next level's `classifyLevel(n+1)`
call overwrites both tables (`pipeline/index.ts`'s `runCodeUpdate` loop).

## Consequences

`classifyLevel` discards `stageClassify`'s own return value entirely;
`assignLevel` is a plain SQL consumer of two fixed table names, unaware of
how many levels ran before it. This mirrors topo-tools-py's own per-level
file-based handoff (`_03a`/`_03b` tables) more closely than passing a JS
object through a call chain would, at the cost of a real ordering
invariant: reordering the per-level loop to run `classifyLevel` for
multiple levels before their matching `assignLevel` calls would silently
read the wrong level's classification.
