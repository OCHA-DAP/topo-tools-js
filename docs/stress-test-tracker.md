# Portolan-catalog stress test tracker

Started 2026-07-08. Datasets are all from the local portolan catalog at
`/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan`. Full
root-cause narrative for the Edge Matcher entries lives in
[`wasm-geos-noding-investigation.md`](./wasm-geos-noding-investigation.md) —
this file is just the status board.

## Problem combos

| Tool | Dataset | Scale | Breaks | Status |
|---|---|---|---|---|
| `/match` | `cod` adm3→adm2 | 519 fine / 164 coarse groups | OOMs mid-run at group ~59/164 (WASM ~3GiB ceiling, driven by **coarse group count**, not fine-feature count) | Failure handling fixed (graceful `58/164 done · 106 failed` + real partial download); underlying OOM itself unfixed, maybe unfixable |
| `/extend` | `idn` adm3 | 7,069 features | All 10 retry attempts OOM identically — connection poisoned on attempt 1, rest are wasted (~4 min) | Unfixed. Suspected cause: `stageLines` (130-140s alone, longer than Ethiopia's whole run) — not confirmed |

**Next steps if revisited:**
- `cod`/`match`: sweep coarse group count alone (fix fine count, try adm3→adm1 at ~26 groups vs. adm3→adm2's 164) to confirm the group-count hypothesis.
- `idn`/`extend`: profile `stageLines` in isolation at increasing scale before attempting a fix.

## Known-good baselines

| Tool | Dataset | Scale | Result |
|---|---|---|---|
| `/match` | `bgd` adm3→adm2 | 507 fine / 64 coarse | Clean, ~5m24s, 0 invalid edges, area conserved |
| `/extend` | `eth` adm3 | 1,148 features | Clean, ~100s, 0 retries |

## Bugs fixed this round

- `src/lib/tools/match/pipeline/groups.ts` — a `finally`-block cleanup query could throw on a poisoned connection and mask an already-caught per-group error, hard-aborting the whole batch instead of recording one failed group and continuing.
- `src/lib/tools/match/pipeline/index.ts` — the post-loop attribute-join/export step had no poisoned-connection fallback, so a partial-success run (e.g. DRC's 58 good groups) still ended in a fatal error with nothing downloadable. Now falls back to a geometry-only export.

## Noticed, not chased

- Edge Extender's retry loop can't tell a real `Allocation failure` (unrecoverable) from the topology/precision failures it's designed to retry past — burns all 10 attempts either way.
- MapLibre console warning (`"Expected value to be of type number, but found null instead"`) on the DRC partial-result run — likely `computeBounds()` returning `null` and the map's fit-bounds call not guarding for it. Cosmetic, unconfirmed.

## Not yet started

- **`/clean`**: OOM-boundary sweep, `bgd`(507)→`cod`(519)→`eth`(1148)→`phl`(1642) adm3.
- **`/change`**: correctness pass on `phl` adm3 v02→v03 (CLAUDE.md's reference case) and a `ukr` adm3 two-version diff (real substantive boundary churn, not just resurvey noise).
