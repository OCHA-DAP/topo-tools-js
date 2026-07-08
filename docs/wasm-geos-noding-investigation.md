# WASM GEOS noding failures in Group Extender — investigation log

> **Naming note**: this tool was renamed mid-investigation to **Edge Matcher**,
> route **`/match`**, folder `src/lib/tools/match/`. This doc still says
> "Group Extender" / `/extend-group` throughout its body for historical
> accuracy (that was the name at the time each entry was written) — read
> every reference to those names as the current Edge Matcher tool. Also:
> plain Edge Extender's (`/extend`) optional clip-to-boundary feature
> (`clip.ts`, referenced in fix #8 below) was **removed entirely** as a
> later product decision — it's gone, not just renamed.

## Symptom

Running Group Extender on real admin-boundary data (Panama: `PAN_ocha_adm3.parquet`
as child layer, `PAN_unhcr_adm2_cleaned.parquet` as parent layer, 76 groups) fails a
meaningful fraction of groups with:

```
Invalid Error: TopologyException: found non-noded intersection between
LINESTRING (...) and LINESTRING (...) at <x> <y>
```

Baseline failure rate on this dataset: **~18% (14/76 groups)**.

Confirmed via direct reproduction (native `duckdb` CLI, spatial extension) that
**this does not happen natively** — only in the browser (`@duckdb/duckdb-wasm`).
Same GEOS version family, same SQL, same input: native succeeds every time on every
group tested. This is a WASM-build-specific GEOS floating-point robustness issue.

## Confirmed facts

- The failure is deterministic **per isolated group** (same group, same input, run in
  isolation, same code → same crash location and same coordinates, every time).
- The failure is **not deterministic across different runs of the full batch** — the
  exact set of groups that fail can shift between otherwise-identical runs (see
  "Non-determinism" below). This is the single most confusing property of this bug.
- Root cause for at least one fully-diagnosed case (Changuinola → Valle del Risco,
  see below): the Voronoi cell computed for a unit can drift by single-digit
  millimeters to a few meters from that same unit's own original boundary, at the
  exact point where they're supposed to coincide. GEOS's noding step throws when a
  later operation has to resolve that near-but-not-quite-coincident seam.
- Precision-reduction as a fix is **not a monotonic "coarser is safer" knob**.
  Empirically chaotic: for Valle del Risco, 11mm and 33mm both failed but
  16.7/22.3/27.8mm in between all succeeded, and separately 111mm also succeeded.
  There is no clean threshold — just scattered working values. This held at even
  finer scale too (a 1-9-per-decade sweep from 0.1mm to 111mm showed the same
  scattered pattern).

## Diagnostic method that actually worked

Two techniques, used together, were what finally produced ground truth (many earlier
attempts based on guessing were wrong — see Timeline):

1. **Checkpoint logging directly in the real pipeline files** (`console.log("[EE-DEBUG] ...")`
   before every `conn.query()` call in `clean.ts`, `lines.ts`, `points.ts`, `voronoi.ts`,
   `merge.ts`, `index.ts`, `groups.ts`). Reading the browser console log after a real
   failing run shows exactly which checkpoint fired last — i.e. which statement was
   in flight when the crash happened. This is far more reliable than wrapping
   suspected statements in `try/catch` and looking for `console.warn` output, because
   (as it turned out) misdiagnosing *which* statement to wrap was the recurring
   mistake, not an inherent uncatchability of the error.

2. **A temporary debug hook** exposing `duckdbState.conn`/`duckdbState.db` on
   `window` (added to `extend-group/App.svelte`, removed after each investigation
   session), combined with `playwright-cli eval` to run hand-written diagnostic SQL
   directly against the **live browser WASM connection** — not native DuckDB (doesn't
   reproduce the bug at all) and not a fresh isolated session run *concurrently* with
   the real batch (introduces a race/contamination confound — see Timeline). The
   reliable pattern: let the batch fully load (`child_layer_01`/`parent_layer_01`/
   `ge_assignment` populated), then fire one self-contained `eval` call using
   `debug_`/`iso_`-prefixed table names that never collide with the batch's own
   `layer_*` tables, and don't touch the connection again until it resolves.

Per-fid isolation (test each child polygon in a group's dissolve individually,
instead of the whole group's `GROUP BY fid` at once) was what actually pinpointed
Valle del Risco within Changuinola's 5-member group.

## Root cause, fully diagnosed: Changuinola → Valle del Risco (fid 10)

- Changuinola's group has 5 child units: Almirante, Changuinola, Guabito, Teribe,
  Valle del Risco.
- Isolating each unit's dissolve individually: **only Valle del Risco fails**, on
  *both* `ST_Union_Agg(geom)` and a Node+BuildArea rewrite (see below) — same
  crash, same coordinates, regardless of algorithm. Confirms it's the geometry, not
  the specific overlay operation.
- Valle del Risco's Voronoi-cell remainder piece is ~12x the *area* of its own
  original polygon (0.14 vs 1.63 deg²) — this unit sits somewhere with few close
  neighbors, letting its Voronoi cell balloon outward a long way before hitting a
  capping boundary.
- Both the original polygon and the oversized remainder pass within ~1.3-1.7×10⁻⁵
  degrees (~1.5-2m) of the exact crash coordinate — i.e. they're *supposed* to
  coincide there (it's a shared-boundary point) but don't, by a couple of meters,
  because of floating-point drift through the point-interpolation → Voronoi
  generation pipeline.

## Fixes tried, in order, with outcomes

| # | Attempt | Scope | Result |
|---|---|---|---|
| 1 | Make `stageCleanInput`'s `ST_CoverageClean` gate unconditional (always run, not just when `ST_CoverageInvalidEdges_Agg` flags something) | All groups, real input | **Made it worse**: 2 → 15 failures. CoverageClean itself has WASM robustness issues; running it on groups that didn't need it added more chances to hit them. Reverted. |
| 2 | Retry `stageLines`+`stageCleanInput` with `ST_ReducePrecision` on failure | Real input (`layer_01`) | **No effect** — byte-identical error every time. Root cause: misdiagnosed location; this code path was never reached because the actual failure (see below) was elsewhere. |
| 3 | Remove the final `ST_CoverageClean` call from `stageMerge` entirely (make `layer_05_tmp3`'s dissolve the direct output) | `stageMerge` | **No effect** — byte-identical error. Confirmed via checkpoint logging: the *actual* crash was one statement earlier (the dissolve itself), not the coverage-clean call that used to follow it. |
| 4 | Unconditional unconditional `ST_ReducePrecision` on real input (`layer_01`), applied once at pipeline start | Real input, all groups | **Worked** for Changuinola at 2e-4 (~22m), but that's a real, visible-scale accuracy cost on real boundary data — user (rightly) uncomfortable with this. Not pursued further as the primary fix. |
| 5 | Replace direct `ST_Union_Agg(geom)` dissolve with boundary-line noding: `ST_BuildArea(ST_Node(ST_Union_Agg(ST_Boundary(geom))))` | `stageMerge` final dissolve | Verified correct on synthetic cases (disjoint multi-part, hole-preserving) but **alone did not fix Changuinola** — same crash, same coordinates, different algorithm. Confirms the instability is in the *geometry* (the near-coincident vertices), not tied to one specific GEOS boolean-overlay code path. Kept as the dissolve method (more robust in general, doesn't hurt), combined with #6. |
| 6 | Retry precision reduction, but scoped **only** to `layer_04` (Voronoi-derived cell geometry), never `layer_01`, with a dense multi-value candidate list (currently 1-9 × {1e-9, 1e-8, 1e-7} + 1e-6, i.e. 0.1mm–111mm) | `stageMerge`, `layer_04` only | Real batch: 18% → 7.9% failure rate (14/76 → 6/76). All candidates stay sub-12cm and only ever touch algorithmically-derived Voronoi geometry, never real input boundaries. Superseded (loop extracted into shared helper) by #7. |
| 7 | Extracted the retry loop from #6 into a shared `withNodingRetry` helper (`src/lib/db/precisionRetry.ts`); refactored `stageMerge` to use it; applied the identical technique to `extend-group/pipeline/groups.ts`'s clip step (`ge_group_clip`'s `ST_Intersection`), reducing precision only on `a.geom` (the `layer_05`/derived side), never `parent_layer_01` (real input) | `stageMerge` (refactor only, same behavior) + `groups.ts` clip step (new fix) | **Confirmed.** Full real batch: 76/76 groups succeeded, 0 failures (down from 6/76). All 6 previously-failing groups (La Pintada, Colon, Gualaca, Pinogana, Sambu, Capira) now pass. Verified via console log that the retry genuinely engaged rather than being a no-op: 41 logged "Noding retry failed" warnings across the batch before landing on a working precision each time. No third failure location surfaced *within this pipeline path*. |
| 8 | Found (by inspection, prompted by the user asking whether the regular Edge Extender tool's own errors were also fixed) a **third, structurally identical instance** of the same `ST_Intersection(derived, real-boundary)` pattern: `edge-extender/pipeline/clip.ts`'s `runClip` (the optional "clip to external boundary" feature used by plain `/extend`, not `/extend-group`). Applied `withNodingRetry` there too, reducing precision only on `a.geom` (`layer_05`), never `clip_selected` (real input) | `edge-extender/pipeline/clip.ts` | Applied proactively — not yet reproduced/confirmed against a real failing case for this specific code path (unlike #6/#7, which were diagnosed against an actual crash). `npm run check` passes. Should be verified against real data that previously crashed plain Edge Extender's clip step, if such a case is available. |
| 9 | Reverted `stageMerge`'s final dissolve from `ST_BuildArea(ST_Node(ST_Union_Agg(ST_Boundary(geom))))` (fix #5) back to a direct `ST_Union_Agg(geom)`, keeping the precision retry from #6/#7 | `stageMerge` final dissolve | **Fixes a severe, separate correctness bug** — see "Second bug class: silent area loss" below. Not a crash-related regression risk: the precision retry (not the boundary/buildarea rewrite) was already confirmed as what eliminates the noding crash, so reverting the dissolve algorithm was expected to be safe. Confirmed via full real-batch re-run: still 76/76 succeeded, 0 crashes, and every group's output area now matches its parent area to within floating-point precision (0.00% deficit across all 76, vs up to 80% deficit before). |
| 10 | Added `stageOutputClean` (`index.ts`): gated `ST_CoverageClean` on `layer_05` after `stageMerge`, `gap=1e-6`, same input-side gating pattern, wrapped in try/catch | `index.ts`, post-`stageMerge` | User-suggested, after spotting residual micro gaps/overlaps in QGIS. Real batch: `GAPS` warning groups 74/76 → 15/76, max ring count per group 111 → 5, still 76/76 no crashes, `ST_CoverageClean` never failed. **Not a complete fix** — see follow-up note below the "silent area loss" section: 3 of the remaining 5 holed features have real, non-micro holes (188m/482m/2.2km diameter), not coverage-clean-fillable seam artifacts. |

## Second root cause found: the group clip step (`groups.ts`)

Checkpoint-tracing all 6 remaining failures (La Pintada, Colon, Gualaca, Pinogana,
Sambu, Capira) from a real full-batch run shows **all six** follow an identical
pattern, different from Changuinola:

```
=== stageMerge ===
=== stageMerge done, runPipeline continuing ===   ← merge fix (#6) succeeds every time
group:2 clip vs parent geometry (ge_group_clip)   ← extend-group's OWN clip step starts
<crash>                                            ← throws here, not in stageMerge
```

I.e. `stageMerge`'s precision-retry fix works reliably for every group observed —
the fix in the table above is validated. The remaining failures are a **second,
separate bug** in `extend-group/pipeline/groups.ts`'s clip step:

```sql
CREATE OR REPLACE TABLE ge_group_clip AS
SELECT a.fid, ST_Intersection(a.geom, c.geom) AS geom
FROM layer_05 a
CROSS JOIN (SELECT geom FROM parent_layer_01 WHERE fid = ${group.parentFid}) c
WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom)
```

Same failure signature (`found non-noded intersection`), same underlying mechanism
presumably: `layer_05`'s outer boundary is supposed to coincide exactly with
`parent_layer_01`'s boundary at the group's edge (that's the whole point of the
group/clip design — adjacent groups meet exactly at the parent boundary), but
floating-point drift through the extension pipeline means they don't, by some small
distance, at some vertex — and `ST_Intersection` chokes on it the same way
`ST_Union_Agg`/`ST_Node` did in `stageMerge`.

This likely also explains part of the apparent non-determinism noted below: the
*exact* geometry of `layer_05` depends on which `layer_04` precision candidate the
merge retry happened to land on for that run, which then affects whether the
*downstream* clip step's independent pathology gets triggered or not. Two separate
bugs, chained.

**Fix to apply**: same technique as `stageMerge` — retry `ST_Intersection` with
`ST_ReducePrecision` applied to `layer_05` (the derived/extended side), never to
`parent_layer_01` (the real input), using the same dense candidate list. Factor the
retry-loop mechanics into a shared helper since this is now the second call site
needing it.

## Second bug class found: silent area loss (not a crash)

Distinct from the noding-crash bug above — this one never throws, produces a
successful pipeline run, and was only caught because the user reported
Group Extender's output "isn't really what I was expecting" and it was
checked against ground truth (parent-area vs. output-area, per group) rather
than just "did it finish."

**Symptom**: `runValidation`'s existing `GAPS in layer_05: N interior rings`
console warning (already present in `index.ts`, warn-only, never surfaced to
the UI) fired for 75 of 76 groups in a full real-batch run — from 1 ring up
to 111. This was previously dismissed as pipeline noise. Cross-checking
per-group output area against each group's parent polygon area (via DuckDB,
`/Users/computer/Downloads/PAN_ocha_adm3_grouped.parquet` vs. the source
files) revealed the true severity: area deficits from 0% up to **80%** on
individual groups. Concrete worst case: **Gobernadora** (a real feature in
the Montijo group) — input area `0.05097`, output area `0.00020`, a 99.6%
loss. This is not a small seam/gap, it's most of a real polygon vanishing.

**Root cause**: `stageMerge`'s dissolve (fix #5 in the table above) used
`ST_BuildArea(ST_Node(ST_Union_Agg(ST_Boundary(geom))))` to merge each fid's
original polygon with its Voronoi-derived extension piece. `ST_BuildArea`
infers solid-vs-hole purely from ring nesting in the noded line network —
it has no concept of "this ring came from the real input, so it must stay
solid." For isolated features (e.g. a small island with no adjacent
neighbors, whose Voronoi cell extends far out into open water), the noded
boundary arrangement can nest backwards: the large extension area becomes
the inferred "solid" polygon, and the original real polygon becomes a
punched-out interior hole. The `GAPS: N interior rings` warning had been
firing on this exact defect all along; it was just never connected to an
actual area measurement.

**Fix**: reverted the dissolve to a direct `ST_Union_Agg(geom)` (fixes-table
row #9). A plain polygon union has no ring-nesting ambiguity — GEOS's
overlay union determines solid-vs-hole via actual point-containment, not
path traversal — so it can't invert real input into a hole. The precision
retry (#6/#7) was independently confirmed to be what actually eliminates
the noding crash (see fix #7's verification, which ran with `ST_BuildArea`
still in place), so dropping `ST_BuildArea` carries no crash-rate cost.

**Verification**: full real-batch re-run after the revert — 76/76 groups
still succeeded (no crash regression), `GAPS` warnings still fire in the
logs but per-group area deficit is now **0.00% on every single group**
(checked via direct SQL against the live `ge_results`/`parent_layer_01`
tables through the `window.__dbg` hook). Gobernadora specifically recovered
to `0.04954` (vs. `0.05097` original — the ~3% difference is the expected,
correct trim from clipping to the parent boundary, not a bug). The
`GAPS`/interior-rings warning still fires (74/76 groups) even though
per-group area now matches parent area almost exactly — this residual is
unexplained and not yet investigated; it does not appear to correspond to
material area loss anymore, but has not been root-caused. Worth another
look before fully trusting the tool on data this check hasn't been run
against.

**Scope note**: `stageMerge` is shared code — this fix applies to *both*
`/extend` (plain Edge Extender) and `/extend-group` (Group Extender), since
both call the same `runPipeline`. Anyone who saw silently-wrong (not
crashed) output from plain Edge Extender since fix #5 was introduced earlier
in this investigation was likely hitting this same defect.

### Follow-up: the residual `GAPS` warnings were mostly real, and mostly tiny

After the dissolve revert above, the `GAPS: N interior rings` warning still
fired on 74/76 groups (just with much lower ring counts than before). The
user, looking at the output in QGIS, identified these as genuine micro
gaps/overlaps at fid seams and suggested `ST_CoverageClean` as the fix.
Added `stageOutputClean` in `index.ts`: gated the same way
`stageCleanInput` already gates the input-side clean (only run
`ST_CoverageClean` when `ST_CoverageInvalidEdges_Agg` actually flags
something on `layer_05`), `gap = 1e-6` (~111mm, this investigation's
established derived-geometry ceiling), `preserveOriginal: true` (keeps the
fid set stable), wrapped in try/catch (a CoverageClean failure leaves
`layer_05` as-is rather than failing the group). Uses the existing shared
`buildCoverageClean` from `src/lib/db/coverageClean.ts` (already used by
Topology Cleaner and the input-side clean) — no new geometry-cleaning code.

**Result**: real batch re-run, still 76/76 succeeded (0 crashes),
`ST_CoverageClean` itself never failed. `GAPS` warning count dropped from
74/76 groups to 15/76, with ring counts per group down from as high as 111
to at most 5. Total output area still matches total parent area to
floating-point precision.

**Important nuance — not all of the 15 remaining holes are micro.** Measured
the actual leftover holes directly (`ST_MaximumInscribedCircle` on the
extracted interior ring, same technique Topology Cleaner uses for its own
gap-width slider): of 5 fids with holes in the final output, 2 are small
(18m, 24m diameter — genuinely sub-visible, below the 111mm gap-fill
threshold only because that threshold works on the *coverage*, not this
specific ring shape), but 3 are not: 188m, 482m, and **2.2km diameter**
(fid 558, "Montijo" itself). A 2.2km hole is a real, visible defect, not a
"micro" seam artifact — raising the CoverageClean `gap` parameter further
would not be the right fix for this one without risking closing legitimate
real gaps elsewhere, since it's coverage-wide, not per-feature. This needs
its own root-cause pass (hypothesis: the Voronoi remainder's
`ST_Difference(v.geom, neighbor_union)` producing a polygon-with-hole when
a neighbor cell sits entirely inside another cell rather than adjacent at
an edge — untested) before deciding on a targeted fix. Not yet investigated
further — flagged for follow-up.

### Follow-up 2: consolidated to a single clean per batch, at the true end

The first pass above put `gatedCoverageClean` inside `runPipeline` on
`layer_05`, called once per group by Group Extender (76×). While
implementing a second call site (post-clip, on `ge_group_clip`, to catch
seams the clip's independent per-fid `ST_Intersection` can reintroduce) plus
a planned third (on the final assembled `ge_results`, to catch cross-group
seams), the user flagged this as over-cleaning: multiple gated-check calls
per group, when only the *final* assembled state is what actually matters
for correctness — `ST_CoverageClean` fixes whatever the geometry looks like
at the moment it's called, so cleaning mid-pipeline only pays off if leaving
a defect uncleaned would compound into something worse downstream (true for
the fix-#9 area-loss bug, not true for a coverage-wide seam gap).

Consolidated to exactly one `gatedCoverageClean` call per tool invocation,
at the true final output:
- **Plain Edge Extender** (`/extend`): unchanged — still cleans `layer_05`
  once inside `runPipeline`, since for this tool (no group loop) that
  genuinely is the end for the no-clip case. Added a second clean, on
  `layer_clip`, at the end of `clip.ts`'s `runClip` — this is not
  "double-cleaning" the same defect, it's the *other* possible final output
  (when the user does clip), and the clip step's own independent
  `ST_Intersection` can reintroduce seams that the `layer_05`-stage clean
  couldn't have anticipated.
- **Group Extender** (`/extend-group`): removed cleaning from inside the
  per-group `runPipeline` call entirely via a new `runPipeline(conn,
  onProgress, { skipOutputClean: true })` option (`RunPipelineOptions` in
  `edge-extender/pipeline/index.ts`), and dropped the post-clip clean
  attempt. Added exactly one `gatedCoverageClean(conn, "ge_results", ...)`
  call in `extend-group/pipeline/index.ts`, after `runGroups` completes and
  the whole batch is assembled — the only point where cross-group seams can
  even be observed, since adjacent groups never share table state during
  the per-group loop.

**Result**: re-ran the full real batch — identical output to the 3-call-site
version (same 5 residual holed fids, same total-area match to
floating-point precision), at a fraction of the check overhead (1 gated
check for the whole batch instead of up to 152). Confirms cleaning at the
true end only is exactly as correct as cleaning at every intermediate step,
for this class of defect — the extra mid-pipeline calls were pure overhead
with no correctness benefit.

## New finding: the retry fix doesn't scale to a large monolithic merge (unresolved)

Discovered while smoke-testing plain `/extend` after removing its clip feature (see
"Product decision" section below) — unrelated to that removal, `merge.ts` and
`precisionRetry.ts` were not touched during that work. This is a previously
untested scenario, not a regression.

**Symptom**: ran plain Edge Extender on the *whole* 76-feature Panama adm2
dataset as a single pass (not per-group, the way Edge Matcher/Group Extender
calls it). `stageMerge` exhausted **all 28 precision candidates** and threw:
`Failed after 28 precision attempts: ... TopologyException: found non-noded
intersection between LINESTRING (-79.521 9.57798, ...) ...`. Every prior
verification of the merge fix in this investigation (76/76 success) ran
`stageMerge` per-group, on small subsets (5-20 features each) — this is the
first time it was exercised as one monolithic 76-feature dissolve.

**Interpretation**: this is likely a genuine scale-dependent limitation, not
a fluke — dissolving 76 features together means resolving noding across many
more shared-boundary pairs at once than any single small group ever
required, so the odds that *some* pair in the batch needs a precision value
outside the current 0.1mm-111mm/28-candidate range go up with feature count.
This is an argument that Group Extender/Edge Matcher's "partition into small
groups, merge each independently" design isn't just about clipping to a
boundary — it's *structurally more robust* against this bug class than
running one large merge, purely by keeping each individual dissolve small.

**Not investigated further tonight** — this needs its own checkpoint-logging
pass (same methodology as the rest of this doc) to find which specific
feature pair is pathological and whether a wider/denser candidate list
would resolve it, or whether some inputs are fundamentally unresolvable by
precision retry alone at any density. Flagged for follow-up, not fixed.

## Non-determinism (important, unresolved)

Across two otherwise-identical runs with different candidate-list densities:

- Narrow list (`[1e-8, 1e-7, 1e-6]`): Dolega and Chepigana failed; La Pintada passed.
- Dense list (28 values, `[1,2,...,9]×{1e-9,1e-8,1e-7}` + `1e-6`): Dolega and
  Chepigana **passed**; La Pintada **failed**.

This means the *set* of groups that fail is not fully deterministic even for
identical code, likely tied to WASM heap state carried over from earlier groups in
the same session (per-fid isolated tests are more deterministic than the real
sequential batch — see Timeline entries on concurrent-execution confounds). Expect
some run-to-run variance in exactly which groups fail; the aggregate rate (~8%) is
the more meaningful number than any single run's exact failure list.

## Current state (as of this entry)

- `merge.ts`: dissolve via `ST_BuildArea(ST_Node(ST_Union_Agg(ST_Boundary(geom))))`,
  wrapped in a retry loop over `MERGE_PRECISION_CANDIDATES` applied to `layer_04`
  only. 28 candidates, 0.1mm–111mm.
- `clean.ts`, `index.ts`: back to original (pre-investigation) behavior — the
  unconditional-CoverageClean and stage-2 retry attempts were both reverted.
- Temporary `[EE-DEBUG]` checkpoint logging is still present in `clean.ts`,
  `lines.ts`, `points.ts`, `voronoi.ts`, `merge.ts`, `index.ts`, `groups.ts` — left
  in place for continued investigation, not yet cleaned up.
- Still-failing groups (most recent full run): La Pintada, Colon, Gualaca, Pinogana,
  Sambu, Capira. **Root cause now diagnosed** — see "Second root cause found" above:
  all six fail in `groups.ts`'s clip step (`ge_group_clip`), not in `stageMerge`.
  `stageMerge`'s fix (#6) is confirmed working for every group observed, including
  these six.

## Open questions / next steps

- [DONE] Diagnose the 6 remaining failures — confirmed all fail in the clip step, not
  `stageMerge`.
- [IN PROGRESS] Apply the same retry-with-precision-reduction technique to the clip
  step's `ST_Intersection`, scoped to `layer_05` (derived) only, never
  `parent_layer_01` (real input).
  - [DONE] Created shared helper `src/lib/db/precisionRetry.ts` exporting
    `NODING_RETRY_PRECISIONS` (the 28-value 0.1mm-111mm list) and
    `withNodingRetry(attempt, precisions?)` (runs `attempt(precision)` per
    candidate, stops at first success, throws wrapping the last error if all
    fail).
  - [DONE] Refactored `stageMerge` (`edge-extender/pipeline/merge.ts`) to call
    `withNodingRetry` instead of its own inline loop — the duplicate loop is
    gone, `merge.ts` now just builds `layer_04` from `layer_04_orig` at the
    candidate precision, then `layer_05_tmp2`/`layer_05` inside the
    `attempt` callback.
  - [DONE] Updated the clip step in `extend-group/pipeline/groups.ts`
    (`ge_group_clip`) to wrap `ST_Intersection` in `withNodingRetry`,
    applying `ST_ReducePrecision` inline to `a.geom` (the `layer_05` side)
    per attempt. No `_orig` preservation table needed here since `layer_05`
    itself is never overwritten by this step (unlike `stageMerge`'s
    `layer_04`, which had to be materialized in place because a later CTE
    expected it under that name) — every retry attempt re-reads the same
    pristine `layer_05` row.
  - [DONE] `npm run check` — 0 errors, 0 warnings (2 pre-existing unrelated
    eslint-config hints).
  - [DONE] Verified against the real Panama batch again (via `playwright-cli`
    against the live dev server, real files): **76/76 groups succeeded, 0
    failures.** All 6 previously-failing groups now pass. No third failure
    location surfaced. See fixes-tried table row #7 for detail.
- [DONE] Failure rate: 18% baseline → 7.9% (fix #6) → **0%** (fix #7, this session).
  Table updated with row #7.
- [IN PROGRESS] Once satisfied with the fix's stability across more real-world
  datasets (not just this one Panama file pair), remove the temporary
  `[EE-DEBUG]` checkpoint logging from `clean.ts`, `lines.ts`, `points.ts`,
  `voronoi.ts`, `merge.ts`, `index.ts`, `groups.ts`, and the `window.__dbg`
  debug hook from `extend-group/App.svelte`. Not removed yet — one clean run
  on one dataset is a good signal, not full confidence; leaving the
  diagnostics in costs nothing and de-risks a second real-world test.
