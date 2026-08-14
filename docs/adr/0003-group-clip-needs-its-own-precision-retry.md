# 0003: Edge Matcher's group-clip step needs its own precision retry

## Status

Superseded by [0022](0022-noding-precision-retry-removed-for-python-parity.md)

## Context

After [0001](0001-precision-retry-mitigates-wasm-noding-failures.md) fixed
`stageMerge`'s noding crash, 6 of 76 Panama groups still failed. Checkpoint
tracing showed all six follow an identical pattern: `stageMerge` succeeds
every time, then the crash occurs in `extend-group/pipeline/groups.ts`'s own
clip step (`ge_group_clip`, an `ST_Intersection(a.geom, c.geom)` between the
group's extended geometry and its known parent boundary). Same failure
signature, same underlying mechanism: `layer_05`'s outer boundary is
supposed to coincide exactly with the parent boundary at the group's edge,
but floating-point drift through the extension pipeline means they don't, by
some small distance, at some vertex.

## Decision

Apply the same retry technique as `stageMerge`: wrap the clip's
`ST_Intersection` in `withNodingRetry`, reducing precision only on the
derived/extended side (`layer_05`), never on the real parent-boundary input.
Factored into a standalone helper, `clipToBoundary` (`src/lib/db/clipToBoundary.ts`),
since this is now the second call site needing the technique (a third,
Edge Extender's own former clip-to-boundary feature, used the same helper
before that feature was removed as a later product decision).

## Consequences

Full real batch: 76/76 groups succeeded, 0 failures (down from 6/76). All 6
previously-failing groups (La Pintada, Colon, Gualaca, Pinogana, Sambu,
Capira) now pass. Verified via console log that the retry genuinely engaged
rather than being a no-op (41 logged "Noding retry failed" warnings across
the batch before landing on a working precision each time).
