# 0025: `clip` needs no per-parent process isolation in WASM

## Status

Accepted

## Context

topo-tools-py's `clip` isolates every parent fid's `ST_Intersection` call in
a freshly spawned OS subprocess (`docs/adr/0015` there): repeated calls leak
GEOS's native heap the same way `extend()`'s Voronoi machinery does, and
only a fresh process per parent reliably reclaims it — confirmed at
continent scale, where a single query or a per-parent loop within one
process both OOM'd. Before porting `clip` to this WASM-based app, the
Phase-C plan required checking whether DuckDB's WASM-compiled GEOS build
exhibits the same leak, since WASM has no OS-process equivalent to isolate
against (a Web Worker per parent was the fallback design if it does).

Spike, run against the already-initialized WASM DuckDB singleton via
`playwright-cli eval` (no code changes):

- 5,500 cumulative `ST_Intersection` calls (transient `SELECT`, no
  materialization) between an 8,001-vertex parent and 500 scattered
  children, `duckdb_memory()`'s total `memory_usage_bytes` sampled every
  100–500 calls: flat at 2 MB throughout.
- 1,000 more calls against a heavier 52,001-vertex parent (Python's real
  failing case was a 281k-vertex parent): flat at 3 MB throughout.
- Control check that `duckdb_memory()` actually tracks GEOS-derived
  allocations at all (ruling out "it just doesn't see them"): materializing
  300 intersection results (5.4M total output vertices) into a real table
  moved `memory_usage_bytes` from 3 MB to 94 MB; dropping that table and
  checkpointing brought it back to 3 MB. The accounting is sensitive and
  the memory is genuinely reclaimed, not just uncounted.

No monotonic growth pattern appeared at any scale tested.

## Decision

`clip` in this app calls `ST_Intersection` directly, once per parent fid,
in the single shared WASM connection — the same pattern every other tool in
this codebase already uses for repeated scalar spatial calls. No per-parent
Web Worker, no subprocess-equivalent isolation layer.

## Consequences

This removes an entire layer of Python's `clip` design (subprocess
spawning, per-fid Parquet handoff, `multiprocessing.get_context("spawn")`
re-exec semantics) that has no counterpart need here. `clip`'s JS
implementation still needs the grid-tiling behavior for very-high-vertex
parents (`CLIP_TILE_MIN_VERTICES` etc.) — that addresses per-call
`ST_Intersection` cost and the SPATIAL_JOIN pitfalls documented in
`docs/explanation/performance.md`, an orthogonal concern from the leak this
spike ruled out. This finding is scoped to the workload actually tested
(transient, non-materialized calls at up to ~52k parent vertices); if a
real-scale `clip` run ever shows unbounded growth across many parent fids
in one session, that would falsify this ADR's premise and the Web Worker
fallback should be revisited then, not assumed unnecessary forever.
