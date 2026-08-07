# 0008: Whole-batch ST_CoverageClean OOM at large scale is a hard WASM ceiling, mitigated not fixed

## Status

Accepted

## Context

Testing against a second, larger real-world dataset (Burundi: Zone→Commune,
465 fine features across 43 groups) reached `DONE - 43/43 groups done`
(every group's own pipeline succeeded) but then threw `Out of Memory Error:
Allocation failure` on the final whole-batch `gatedCoverageClean` call added
in [0004](0004-consolidate-coverageclean-to-single-final-call.md), losing
the entire result.

Root cause: `current_setting('memory_limit')` in this WASM build reports a
hard **3.0 GiB** ceiling, independent of host RAM — a 32-bit WASM
linear-memory constraint, not a DuckDB config value that can be raised.
Confirmed `SET memory_limit='8GB'` is accepted by DuckDB's own accounting
but produces bit-for-bit identical timing and failure against the real
465-feature file — `memory_limit` has zero power over the browser's actual
`memory.grow()` ceiling. WASM's `memory.grow()` is also one-directional:
once a large allocation fails, the connection is poisoned for the rest of
the session (confirmed: even a trivial subsequent query fails to commit).
Independently reproduced the identical OOM by feeding the same pre-clean
export into Topology Cleaner (`/clean`) standalone — rules out anything
specific to Edge Matcher's own pipeline ordering.

Four mitigation options were tested and ruled out, each with direct
evidence: (1) scoping the clean to only seam-adjacent polygons — rejected on
correctness grounds without testing, since cross-group seams can only be
observed at the whole-batch assembled state; (2) proactive
`ST_ReducePrecision` before the clean — non-monotonic and dangerous (two
finest values were a wash with baseline, coarser values were 2.8x slower or
hung outright); (3) an explicit `snap` tolerance instead of auto — same
shape, auto was already near-optimal and the coarse end hung; (4) raising
`SET memory_limit` above the ~3.1 GiB default — accepted by DuckDB but
produced bit-for-bit identical failure against the real file, confirming
`memory_limit` has no power over WASM's actual heap ceiling. OPFS was also
investigated as a way to raise the ceiling via `temp_directory` spill, but
that's not reliably supported by the officially published
`@duckdb/duckdb-wasm` package (only an unaudited third-party fork), which
was rejected on supply-chain-risk grounds.

## Decision

No lever tested makes `ST_CoverageClean` itself survive at this data scale
in WASM. Mitigate instead of fix: export the geometry from the
already-correct `ge_results` table *before* attempting the whole-batch
clean (`match/pipeline/index.ts`), wrapped in try/catch so a clean failure
falls back to the pre-clean export rather than losing the whole batch. Also
free every scratch table no longer needed (per-group leftovers via
`dropInternalTables`, plus match-level tables like `ge_pairs` right after
their last reader) before attempting the clean, to buy what headroom is
available — though this alone was measured as insufficient to let the
clean itself succeed at Burundi's ~465-feature scale.

## Consequences

`ge_results` without the final clean is still a fully valid result (every
fid clipped to its own parent boundary); the only cost of the clean failing
is possible micro-seams at group boundaries a per-group clean couldn't have
seen anyway (see [0011](0011-near-miss-cross-group-edges-accepted-as-cosmetic.md)
for why those seams carry zero real area cost). Re-verified on the full
Burundi batch: reached completion with the pre-clean export, `ge_results`
ground truth unchanged (465/465 valid, correct total area). A real fix
would need to either shrink `ST_CoverageClean`'s peak memory footprint
(chunking the input — not investigated) or lift the 3 GiB WASM ceiling
(blocked on OPFS spill support) — both out of scope for now.
