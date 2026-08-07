# 0017: Loader dedupes registered file names to prevent same-basename load collisions

## Status

Accepted

## Context

DuckDB-WASM's registered-file namespace is keyed by name. The portolan
catalog exports every country under the same literal basename
(`original.parquet`), and dropping two different files sharing that
basename in one session left stale Parquet metadata behind even after
`dropFile()`, producing `Invalid Input Error: Failed to read file
"original.parquet": ZSTD Decompression failure` on the second load —
confirmed a registration collision, not bad data (the same file loaded
clean on a fresh session).

## Decision

Added `src/lib/db/id.ts` (`randomId()`, extracted from the duplicate logic
already in `duckdb.svelte.ts`'s `makeSessionDbName`) and prefixed every
registered file/shapefile-component name with a per-call id (`loader.ts`).

## Consequences

Verified `bgd`→`cod` back-to-back in one session (the exact repro): both
now load clean, `cod`'s result matching its standalone baseline exactly
(0/0/6).
