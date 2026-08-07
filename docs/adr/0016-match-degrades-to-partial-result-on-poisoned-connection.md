# 0016: Edge Matcher degrades to a partial result instead of losing a whole batch on a poisoned connection

## Status

Accepted

## Context

Once a group OOMs, the WASM connection stays poisoned for the rest of the
session (see [0008](0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md)).
Two places downstream assumed otherwise and turned that into total data loss
instead of a partial result: `groups.ts`'s per-group `finally`-block cleanup
query could itself throw on the poisoned connection, and since that throw
happened inside `finally` (not the already-executed `catch`), it replaced
the caught per-group error and aborted the whole loop instead of recording
one failed group and continuing; `index.ts`'s post-loop attribute-join/export
step had no fallback for the same failure, so a batch with real,
already-computed groups still ended in a fatal error with nothing
downloadable.

## Decision

Guard the `finally`-block cleanup in `groups.ts` so a throw there can't
override the per-group `catch`. Give the post-loop export step in
`index.ts` a fallback to a geometry-only export when the attribute join
fails on a poisoned connection.

## Consequences

Verified live against DR Congo adm3→adm2 (519/164), which reliably OOMs
partway through: the run now reaches "Done", reports "58/164 groups done ·
106 failed" honestly, and produces a downloadable partial result instead of
a blank error panel.
