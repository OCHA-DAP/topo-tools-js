# 0043: Schema Map inference follows topo-tools-py 0.12

## Status

Accepted

## Context

`schema-map`'s inference was ported from topo-tools-py before its sparse
joint-row clustering (py #104, ADR 0114), strong and bridged chain edges,
the naming veto (py ADR 0113), embedded-edge tie-breaks, the shape tie,
`--level` and implied-country numbering, fractional-column exclusion, and
blank-parent embedding (py #82 to #129, #159). Level detection likewise
lacked py's shared-naming anchors and name-only leaf level (py #81, #37).
Its explanation listed these as deferred. On COD-AB files with partly
populated alternate names, JS bracketed those columns as `ambiguous` where
py kept them on their level, and every tool built on `detectLevelColumns`
saw different levels from its py counterpart.

## Decision

Port py's `_02_map.py` and `_level_columns.py` at 0.12 function by
function into `inference.ts`, `queries.ts` and `levelColumns.ts`, including
the schema-map parts of py #159/#168 (`breakShapeTie`,
`supplementalColumns`, `verifyFunctionalCluster`'s coarser-member check).
Schema Map always runs with implied-country numbering, as py's CLI does,
and exposes py's `--level` as an optional finest-level field (`level`).

## Consequences

Schema Map produces py's crosswalk, and `detectLevelColumns` py's levels,
on the same file. A varying coarsest level is now numbered 1 rather than 0
in Schema Map, and tools on `detectLevelColumns` can now see a name-only
leaf level (`hasCode = false`), which `schema-fill` and the code tools
reject like py does. Inference runs more queries per file (joint-row and
strict-containment checks per column pair); the column counts involved
keep this small.
