# Portolan-catalog stress test tracker

Started 2026-07-08. Datasets are all from the local portolan catalog at
`/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan` — see
[`docs/how-to/at-scale-testing.md`](how-to/at-scale-testing.md) for how to
pick a file or version pair. This file is the live bug-status board; it is
not part of the `docs/` Diátaxis tiers.

## Problem combos

| Tool | Dataset | Scale | Breaks | Status |
|---|---|---|---|---|
| `/match` | `cod` adm3→adm2 | 519 fine / 164 coarse groups | OOMs mid-run at group ~59/164 (WASM ~3GiB ceiling, driven by **coarse group count**, not fine-feature count) | Failure handling fixed (graceful `58/164 done · 106 failed` + real partial download); underlying OOM itself unfixed, maybe unfixable |
| `/extend` | `idn` adm3 | 7,069 features | All 10 retry attempts OOM identically — connection poisoned on attempt 1, rest are wasted (~4 min) | Unfixed. Suspected cause: `stageLines` (130-140s alone, longer than Ethiopia's whole run) — not confirmed |
| `/clean`, `/change` | `phl` adm3 (`original.parquet`, v02 or v03) | 1,642-1,647 features, but **~161 MB** file | **Hard browser-tab crash**, reproduced 3x across two different tools (`/clean` and `/change`) — the whole headless-Chromium tab dies mid-drop, before either tool's pipeline starts. App itself recovers fine on reload. | Very likely a **headless-Playwright/dev-environment memory ceiling on the raw file drop**, not an app bug — a real browser on production got past the equivalent step with an even bigger (187 MB) file (see below). Treat local headless testing as capped at roughly 100-150 MB files; anything bigger needs real-browser verification instead |

**Next steps if revisited:**
- `cod`/`match`: sweep coarse group count alone (fix fine count, try adm3→adm1 at ~26 groups vs. adm3→adm2's 164) to confirm the group-count hypothesis.
- `idn`/`extend`: profile `stageLines` in isolation at increasing scale before attempting a fix.
- `phl`/large-file testing: only pursue in a real (non-headless) browser from here on — headless repro has served its purpose (found the ceiling exists) and further headless attempts just recrash without new information.

## Real-browser results

| Tool | Dataset | Scale | Result |
|---|---|---|---|
| `/clean` | `phl` v03 **adm4** (production, tools.fieldmaps.io) | 42,048 features, **187 MB** | Got past Load file + Analyze coverage into "Finding gaps, overlaps & slivers" (already further than headless Playwright got with the much smaller 161 MB adm3 file — confirms the headless crash is environment-specific, not an app ceiling). Sat in that stage long enough that the user gave up and stopped it manually — no crash, no OOM error surfaced, just open-ended. Inconclusive: unknown whether it would have finished given more time, or was truly stuck. Worth re-running with a longer wait budget (single-threaded WASM on 42k features could plausibly take many minutes) before concluding anything's actually wrong. |

## Known-good baselines

| Tool | Dataset | Scale | Result |
|---|---|---|---|
| `/match` | `bgd` adm3→adm2 | 507 fine / 64 coarse | Clean, ~5m24s, 0 invalid edges, area conserved |
| `/extend` | `eth` adm3 | 1,148 features | Clean, ~100s, 0 retries |
| `/clean` | `bgd` adm3 | 507 features (12 MB) | Clean, ~35s, 0 overlaps, 0 gaps, 5 slivers |
| `/clean` | `cod` adm3 | 519 features (4.8 MB) | Clean, ~35s, 0 overlaps, 0 gaps, 6 slivers |
| `/clean` | `eth` adm3 | 1,148 features (9.3 MB) | Clean, ~25s, 0 overlaps, 0 gaps, 2 slivers |
| `/change` | `ukr` adm3 v02→v04 | 1,770 A-features / 1,769 B-features (14-15 MB each) | Clean, ~45s. 1287 unchanged, 481 modified (IoU 0.48-0.98), 1 merge (2 A→1 B), 0 created/removed. **Correctness-verified**: row totals exactly conserved (1287+481+2=1770=A total; 1287+481+1=1769=B total, no orphans); the one real substantive change — small "Sevastopol" city unit (`UA8500000`, 6.7% of new area) + "Sevastopilska" raion (`UA0102000`, 93.2%) consolidated into one new `UA8500000` "Sevastopol" adm3 unit, area conserved at ~99.9% — correctly classified as `merge`, not the naive "removed" a pcode-only diff would suggest (pcode schemes are also non-comparable across versions here, confirming the tool correctly relies on geometry overlap, not code matching, by default) |

## Bugs fixed this round

- `src/lib/tools/match/pipeline/groups.ts` — a `finally`-block cleanup query could throw on a poisoned connection and mask an already-caught per-group error, hard-aborting the whole batch instead of recording one failed group and continuing.
- `src/lib/tools/match/pipeline/index.ts` — the post-loop attribute-join/export step had no poisoned-connection fallback, so a partial-success run (e.g. DRC's 58 good groups) still ended in a fatal error with nothing downloadable. Now falls back to a geometry-only export.
- `src/lib/db/loader.ts` — files were registered with DuckDB under their literal `file.name` (e.g. `original.parquet`, common with this catalog since every country exports under that same basename). Dropping two different files sharing a filename in one session corrupted the second load: `Invalid Input Error: Failed to read file "original.parquet": ZSTD Decompression failure` — confirmed a registration collision, not bad data (the same file loaded clean on a fresh session). Fix: added `src/lib/db/id.ts` (`randomId()`, extracted from the duplicate logic already in `duckdb.svelte.ts`'s `makeSessionDbName`) and prefixed every registered file/shapefile-component name with a per-call id. Verified: `bgd`→`cod` back-to-back in one session (the exact repro) now both load clean, `cod`'s result matching its standalone baseline exactly (0/0/6).

## Noticed, not chased

- Edge Extender's retry loop can't tell a real `Allocation failure` (unrecoverable) from the topology/precision failures it's designed to retry past — burns all 10 attempts either way.
- MapLibre console warning (`"Expected value to be of type number, but found null instead"`) on the DRC partial-result run — likely `computeBounds()` returning `null` and the map's fit-bounds call not guarding for it. Cosmetic, unconfirmed.

## Not yet started

- **`/change`**: correctness pass on `phl` adm3 v02→v03 (CLAUDE.md's reference case) — blocked locally by the same ~161 MB headless-browser crash as `/clean`/`phl` above; needs a real (non-headless) browser.
