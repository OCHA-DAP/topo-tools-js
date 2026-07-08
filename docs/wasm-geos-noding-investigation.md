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
| 11 | `stageMerge`'s final dissolve: apply `ST_ReducePrecision(geom, precision)` to **both** rows being unioned (the untouched original `layer_01` row and the derived remainder), not just the derived side | `stageMerge` final dissolve | **Fixes the whole-dataset monolithic-merge failure** (see "New finding" section, now resolved below). Root cause: reducing only the derived side left it on a different rounding grid than the untouched real-input row, so GEOS could see a near-miss as a crossing instead of a touch. Confirmed on Santa Isabel (PAN adm2 fid 14): reducing only `layer_04` exhausted all 28 candidates every time; reducing both sides fixed it at every candidate down to the finest (0.1mm). Re-verified full real batch for both tools: plain `/extend` monolithic 76-feature merge now succeeds (0 shrunk features, 0 invalid geometries), and `/match` per-group run (including the Santa Isabel group) still 76/76, 0 unassigned, 0 invalid. |
| 12 | Restructured fix #11 into a **tiered retry**: sweep all 28 candidates reducing only the derived side first (cheaper, never touches real input); only if that entire sweep is exhausted, escalate to a second 28-candidate sweep that also reduces the real-input row | `stageMerge`, `attemptDissolve()` helper | User-requested refinement — keeps the project's "never touch real input unless necessary" default for the common case, while preserving fix #11's robustness as a fallback. Same observable behavior as #11 whenever the derived-only tier succeeds (the vast majority of cases); functionally identical to #11 when it doesn't. See "Precision-density experiment" section below for the follow-up analysis this prompted. |

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

## New finding: the retry fix doesn't scale to a large monolithic merge (RESOLVED)

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

**Diagnosis** (checkpoint methodology: added `window.__dbg` to
`edge-extender/App.svelte` — it previously only existed on `match/App.svelte`
— and queried the live connection directly after the crash left
`layer_05_tmp2`/`layer_04`/`layer_01` populated at their last-attempted
state). Located the exact pathological point (`-79.521, 9.57798`, from the
error message) in `layer_05_tmp2`, found two candidate fids nearby, and
isolated the failure to a single `ST_Union_Agg(geom) WHERE fid = 14`
("Santa Isabel", a real adm2 unit). **This turned out not to be a
scale/neighbor-count effect** — Santa Isabel's bbox only pulled in 5
distinct neighboring parts, well within the size of groups already verified
elsewhere in this doc. Instead: the union combines two rows — the untouched
real `layer_01` polygon (full float64 precision, never reduced by design)
and the derived Voronoi remainder (already `ST_ReducePrecision`'d). Since
only the derived side is snapped to the retry grid, the two rows' supposedly
coincident boundary vertices can still land a few ULPs apart, which GEOS can
report as a crossing instead of a touch — the exact same failure class as
the rest of this doc, just at a union step whose real-input side had never
been included in the reduction before.

**Fix** (table row #11): apply `ST_ReducePrecision` to **both** sides of the
union at the same per-attempt candidate value, not just the derived side.
Verified directly against `layer_05_tmp2 WHERE fid = 14`: reducing only the
derived side failed at every one of the 28 candidates (matching the observed
crash); reducing both sides succeeded at every candidate tested, including
the finest (0.1mm) — a cost far below the accuracy of any real admin
boundary, and it only affects this transient union input, never persisted
back onto real data.

**Re-verification, full real batch, both tools**:
- Plain `/extend`, whole 76-feature Panama adm2 dataset as one monolithic
  merge (the exact failing case): now succeeds. Ground-truth checks: 76/76
  input fids present in output, 0 features with output area smaller than
  input (extension should only grow, never shrink), 0 invalid geometries.
- `/match`, Panama adm3-into-adm2 (76 groups, including the Santa Isabel
  group that was the isolated failure case): still 76/76 groups succeeded, 0
  unassigned, 0 invalid geometries, total output area matches expectations
  from the previously-verified run.

**Conclusion**: not actually a scale-dependent limitation in the sense
originally hypothesized (more neighbors → more pathological pairs) — it was
a gap in which side(s) of the union got the precision-retry treatment, that
happened to only be exercised once a group merge included this specific
real-input row directly (rather than only via its already-clipped/extended
form). The "partition into small groups" design is not what makes Edge
Matcher robust here; both tools now use the same (now-corrected) shared fix.

## Tiered retry restructure, and a precision-density experiment

After fix #11 landed, the user asked two follow-up questions: (1) how much
precision reduction is actually being applied, and (2) whether the retry
could try reducing *only* the derived Voronoi remainder first, escalating to
reducing the real input only if that's insufficient — matching this
project's existing default of never touching real input unless necessary.

**Tiered restructure** (fixes-table row #12): `merge.ts` now has a single
`attemptDissolve(conn, precision, reduceOriginalToo)` helper. `stageMerge`
calls `withNodingRetry` once with `reduceOriginalToo = false` (derived-only,
all 28 candidates); only if that whole sweep throws does it catch and retry
with a second `withNodingRetry` pass at `reduceOriginalToo = true`. `layer_04_orig`
(the pristine, pre-reduction Voronoi output) is preserved across both tiers
so retries never compound precision loss from a previous failed attempt.

**Precision-density experiment**: the user then asked whether the current
28-candidate list (integer multiples 1-9 of each decade `{1e-9, 1e-8, 1e-7}`,
plus `1e-6`) is well-chosen, or whether denser/fractional spacings (0.5x,
0.25x, 0.333x, etc.) would do better, and asked for an empirical sweep.

Built a 155-candidate list spanning 5 decades (`1e-9` to `1e-5`) x 31
multiples per decade (integers 1-9.5 plus fractions: halves, thirds,
quarters, etc.), tested against the reproducible whole-dataset monolithic
merge failure, isolating the single pathological fid via `window.__dbg`
against the live connection (same methodology as the original diagnosis).

**A methodological trap surfaced first, itself a useful finding**: rerunning
the `/extend` pipeline from scratch on the identical input file produced a
*different* pathological fid than the original diagnosis (fid 62 this time,
not fid 14/"Santa Isabel") — direct evidence that the Voronoi diagram output
is not bit-stable across separate pipeline runs on the same input, so
"the known failing case" is a moving target from run to run, not a fixed
fixture that can be diagnosed once and reused indefinitely. (This is the
same underlying non-determinism already flagged below, now observed at finer
grain: not just "which groups fail" but "which specific fid, within a
successful monolithic run, ends up on the pathological geometry.") Confirmed
the new pathological fid by isolating each of the 51 distinct Voronoi-cell
groups individually at the one precision value (`8e-9`) that failed in a
whole-dataset re-run, and finding exactly one (fid 62) reproduced the crash
in isolation — validating that single-fid isolation, done with the *exact*
production `CASE` logic, faithfully reproduces the full-batch failure (an
earlier isolation attempt that accidentally reduced precision on both sides
unconditionally, instead of matching the derived-only tier, silently found
zero failures — a reminder that isolation tests must mirror the real
`CASE WHEN is_derived OR reduceOriginalToo` branch exactly, not just the
general shape of the query).

**Result of the actual density sweep** (155 candidates x 2 modes, fid 62):
- **Derived-only**: 154/155 passed. The single failure was `8e-9` — with
  both immediate neighbors in the list, `7.5e-9` and `8.5e-9`, passing. No
  cluster, no trend by decade or by integer-vs-fractional multiplier: the
  failure is an isolated point, not a "bad region" a denser grid would help
  route around.
- **Both-sides**: 155/155 passed, matching fix #11's original finding that
  reducing both sides is robust across the full tested range.

**Conclusion**: density and non-integer spacing do not measurably help. A
155-value sweep found essentially the same signal as the original 28-value
list — a single-point, needle-in-a-haystack failure with immediate
neighbors on either side succeeding — which is the signature of an exact
floating-point coincidence at one specific rounding grid, not a systematic
region of instability that finer or differently-spaced candidates would
avoid. This validates the current `NODING_RETRY_PRECISIONS` list as already
adequate: the value of the retry loop is having *several* independent
candidates to try (so a single unlucky exact-coincidence miss doesn't stop
the pipeline), not the specific spacing or density of those candidates. No
change made to `src/lib/db/precisionRetry.ts` as a result of this
experiment.

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

## Second real-world dataset: Burundi (validates fixes #11/#12, surfaces an unrelated OOM bug)

Tested against a second, independent, larger real-world dataset (Burundi's
"Nouveau découpage administratif": Province/Commune/Zone/Colline hierarchy) to
check whether the noding-crash fixes generalize beyond the one Panama file
pair every prior entry in this doc was diagnosed and verified against.

**Plain `/extend`** (43-feature Commune layer, monolithic single-pass merge —
the same code path as the Santa Isabel whole-dataset case in fix #11):
succeeded with zero noding crashes, 0 invalid geometries, correct area
preservation.

**`/match`** (Zone → Commune, 43 groups covering 465 fine features): also
completed with zero noding crashes across all 43 groups. Confirms fixes
#11/#12 (both-sides precision reduction on the monolithic case, tiered retry
restructure) hold on a dataset roughly 6x larger by feature count than
Panama, with a different real-world topology. No new noding failure surfaced.

### New, unrelated bug found during this test: whole-batch OOM on final CoverageClean

Distinct from every bug above — this is a memory-capacity limit, not a
GEOS/noding robustness issue. Symptom: `/match`'s Zone→Commune run (465
features, 43 groups) reached `DONE - 43/43 groups done` (every group's own
`runPipeline` succeeded) but then threw `Out of Memory Error: Allocation
failure` and lost the entire result.

**Root cause**: `current_setting('memory_limit')` in this WASM build reports a
hard **3.0 GiB** ceiling, independent of host RAM (confirmed 16GB via
`sysctl hw.memsize` — this is a 32-bit WASM linear-memory constraint, not a
DuckDB config value that can be raised). The final whole-batch
`gatedCoverageClean(conn, "ge_results", ...)` call (added in "Follow-up 2"
above, run once at the true end over the fully assembled 465-feature result)
is the dominant memory cost at this scale and exceeds that ceiling.
Critically, WASM's `memory.grow()` is one-directional: once a large
allocation fails and the heap is left fragmented/exhausted, the connection is
poisoned for the rest of the session — confirmed empirically that even a
trivial subsequent query (`SET temp_directory`, a small `CREATE TABLE`) fails
to commit with the same `Allocation failure` after the first OOM.
`gatedCoverageClean` itself never throws (it catches `ST_CoverageClean`
failures internally and leaves the target table untouched) — the uncaught
crash was in the *next* step, `tableToGeoJSON`, which runs on the same
poisoned connection.

**OPFS investigated as a possible fix, not adopted.** The app already uses
OPFS for persistent *storage* (the main DB and an ATTACHed "edge" data DB both
live at `opfs://...` paths), so the natural question was whether OPFS could
also serve as *query-execution spill* (DuckDB's `temp_directory`
out-of-core mechanism) to raise the effective ceiling past 3 GiB. Confirmed
via GitHub discussion duckdb/duckdb-wasm#1322 and direct testing that
`temp_directory`-backed spilling is not reliably supported in the officially
published `@duckdb/duckdb-wasm` package — it only works via an unofficial
third-party fork (`duckdb-wasm-opfs-tempdir`), which was explicitly **not**
adopted here due to supply-chain risk (unaudited third-party fork of a
security/data-integrity-sensitive dependency). Went with a lower-risk
in-house fix instead.

**Fix, three rounds:**

1. Export `dropInternalTables` (`edge-extender/pipeline/index.ts`) so Edge
   Matcher's per-group loop can free the *last* group's `runPipeline` scratch
   tables once the loop ends, not just at the top of the next call (which
   never happens after the last iteration). Correct and free, but measured as
   **insufficient alone**: timing comparison with/without showed virtually no
   change (25.8s vs 25.6s to OOM) — a single group's leaked scratch tables are
   small relative to the 3 GiB ceiling.
2. Reordered `runEdgeMatch` (`match/pipeline/index.ts`) to export the GeoJSON
   from the correct, already-verified `ge_results` **before** attempting the
   whole-batch `gatedCoverageClean`, wrapped in try/catch so a clean failure
   falls back to the pre-clean export instead of losing the whole batch.
   `ge_results` without this clean is still fully valid (every fid clipped to
   its own parent boundary) — the only cost of the clean failing is possible
   micro-seams at group boundaries that a per-group clean couldn't have seen
   anyway. **Verified working**: full re-run reached `Download GeoJSON`,
   `ge_results` ground truth unchanged (465/465 valid, area
   `2.176030274385892`), downloaded file confirmed correct
   (465 features, correct `group_id`/`parent_*` attribute join).
3. User follow-up ("did you clean up all the memory before trying that last
   `ST_CoverageClean`?") caught that round 1 only covered
   `edge-extender`-pipeline-owned scratch tables, not match-tool-level session
   tables that were also still resident and unneeded by clean time:
   `ge_pairs` (dropped in `assign.ts`, right after `computeAssignment`'s three
   output tables are built — nothing downstream reads it), and `ge_groups` /
   `child_layer_01` / `parent_layer_01` / `parent_layer_attr` / `ge_assignment`
   (dropped in `index.ts`, after `buildResultsAttrTable` — the last reader of
   each). Deliberately did **not** drop `ge_unassigned` or `child_layer_attr`
   — `src/lib/db/export.ts`'s `match_unassigned` download source reads both
   live, on demand, whenever the user clicks that button, which can happen
   well after `runEdgeMatch` returns.

**Result of round 3, re-verified on the same Burundi batch**: `ST_CoverageClean`
still OOMs at the same point (`Out of Memory Error: Allocation failure`) —
freeing these additional tables was not enough to let the clean succeed
outright at this scale. The round-2 fallback held as designed: "Output
CoverageClean/re-export failed, keeping pre-clean export" logged, run still
reached completion, `ge_results` ground truth identical to the round-2 run
(465/465 features, 0 invalid, area `2.176030274385892`). **Conclusion**: the
whole-batch `ST_CoverageClean` step itself, not scratch-table bloat, is the
actual ceiling at ~465-feature scale — round 3's cleanup is still correct and
worth keeping (frees memory sooner, costs nothing), but the load-bearing fix
for *not losing the run* is round 2's export-before-clean reorder, not the
table cleanup. A real fix for letting the clean itself succeed at this scale
would need to either shrink `ST_CoverageClean`'s peak memory footprint
(chunking the input? not investigated) or find a way to raise the 3 GiB WASM
ceiling (blocked on OPFS spill support, per above) — both out of scope for
this round.

### Independent confirmation: Topology Cleaner hits the same ceiling standalone

The user asked whether feeding Edge Matcher's pre-clean `ge_results` export
into Topology Cleaner (`/clean`, a separate, dedicated, well-tested tool)
would do better than the in-line `gatedCoverageClean` call — a fresh page,
fresh WASM connection, no match-pipeline state competing for memory.

Downloaded the actual 465-feature GeoJSON output (116MB) and dropped it into
`/clean`. **Result: identical OOM** — the user confirmed it failed at the
same step, `ST_CoverageClean` itself (Topology Cleaner has no separate
"clean" button; fixing topology is its one final step, run automatically).
This is a clean, valuable negative result: it rules out "something specific
to how Edge Matcher orders its work" as the cause, and confirms the ~3 GiB
WASM ceiling is a property of `ST_CoverageClean` at this feature
count/geometry complexity, full stop — not fixable by moving the call to a
different tool or a fresher connection.

### Two more real bugs found while preparing this test (unrelated to the OOM)

**1. Loader crash on re-ingesting a prior export (`duplicate column name
"OGC_FID"`).** Feeding Edge Matcher's own GeoJSON output back into Topology
Cleaner failed immediately with `Binder Error: table "st_read" has duplicate
column name "OGC_FID"`, even before any pipeline logic ran. Root cause:
DuckDB's `ST_Read` always adds its own FID column hardcoded to the name
`OGC_FID` (confirmed empirically — present even when the source data has no
such field at all; no `st_read` parameter suppresses it). The Burundi source
shapefiles' attribute table already had a real property literally named
`OGC_FID` (a common artifact of any data that passed through a prior
`ogr2ogr`/GDAL export, since that's GDAL's own default FID field name), and
that property survived Edge Matcher's attribute join into the final export —
so re-reading that export collided with `ST_Read`'s synthetic column of the
same name. Confirmed the binder error happens even on `SELECT COUNT(*)` or
positional `SELECT #1` — the whole relation fails to bind, not just `SELECT
*`, so there's no SQL-side workaround once the file is registered.
**Fix** (`src/lib/db/loader.ts`, `renameCollidingOgcFid`): for `.geojson`/
`.geojsonl` inputs specifically (plain JSON, cheap to parse/rewrite
losslessly — unlike the binary/XML formats also supported), scan every
feature's `properties` for a key literally named `OGC_FID` before
registering the file buffer with DuckDB, and rename it to `OGC_FID_orig` if
present. Verified directly against the failing file natively (`duckdb` CLI):
`DESCRIBE`/`SELECT *` on the renamed file now bind cleanly, with
`OGC_FID_orig` preserving the original value and `OGC_FID` unambiguously
DuckDB's own FID. Not yet extended to GPKG/SHP/KML/GML/GPX — same collision
risk exists there in principle (DBF's 10-char field limit even accommodates
`OGC_FID` exactly), but binary/XML formats aren't cheaply patchable at the
file-buffer level the way JSON is, and no repro exists yet for those formats.

**2. `clipToBoundary`'s `ST_Intersection` can produce a `GEOMETRYCOLLECTION`
instead of a clean polygon.** Loading the (loader-bug-fixed) match output
into QGIS surfaced a feature QGIS couldn't render as part of the polygon
layer. Isolated to `OGC_FID_orig=226` (group 23, "Mabanda" zone): its
geometry was a `GEOMETRYCOLLECTION` of 38 parts — one real polygon
(area 0.00982, the whole feature) plus 37 near-zero-area sliver polygons
(areas from `1e-15` down to `1e-24` — pure floating-point noise) and one
zero-area stray `POINT`. Root cause: `src/lib/db/clipToBoundary.ts`'s
`ST_Intersection(a.geom, c.geom)` between the group's extended geometry and
its parent boundary — where the two edges are supposed to touch exactly
rather than cross — can return mixed-type noise at the near-tangent contact
points instead of a clean polygonal result; GEOS's overlay doesn't guarantee
a pure-polygon result type for boundary-touching cases the way it does for a
proper crossing. Any consumer expecting `POLYGON`/`MULTIPOLYGON` (QGIS
included) breaks on the resulting `GEOMETRYCOLLECTION`.
**Fix**: wrap the intersection in `ST_CollectionExtract(geom, 3)` (keep only
polygonal parts, code `3`). Verified directly against the actual failing
geometry: total area unchanged (`0.009824911645464169`, exact match before
and after), only the zero-area stray point dropped, output type now a clean
`MULTIPOLYGON`. The 36 remaining sliver polygons (still present, still
absurdly small) are geometrically valid and harmless — no area-threshold
filtering added, since picking a cutoff would be exactly the kind of
arbitrary magic-number fix this project's precision conventions warn
against, and the actual reported defect (the type-breaking collection) is
already fully resolved without one.

## Four OOM-mitigation options tested and ruled out

Following the independent Topology Cleaner OOM confirmation above, four ways
to make the whole-batch `ST_CoverageClean` OOM (on the ~465-feature Burundi
Zone output) survivable were evaluated. All four are dead ends, each with
direct evidence rather than assumption:

**Option 1 — scope the clean to only seam-adjacent polygons, skip interior
ones.** Rejected *without* testing, on correctness grounds: this exact
pattern (multiple gated-clean call sites, each scoped to less than the full
final output) was tried earlier in this investigation and reverted — see
"Follow-up 2: consolidated to a single clean per batch, at the true end"
above. Cross-group seams can only be observed at the whole-batch assembled
state, since adjacent groups never share table state during the per-group
loop; a geometric "near a seam" filter has the same blind spot, and a missed
polygon means a real defect ships silently uncleaned. Withdrawn before
implementation.

**Option 2 — proactively reduce precision before freezing the
`ST_CoverageClean` input array** (distinct from the existing noding-retry
precision reduction, which only fires after a crash). Tested natively via
`ST_ReducePrecision` at five grid sizes before the same `ST_CoverageClean`
call used elsewhere in this doc:

| Precision | Time | Peak memory | Parts |
|---|---|---|---|
| none (baseline) | 18.21s | 2.29 GB | 547 |
| 1e-9 (0.1mm) | 22.62s | 2.11 GB | — |
| 1e-8 (~1mm) | 18.99s | 2.06 GB | — |
| 1e-7 (~11mm) | **51.69s (2.8x slower)** | 1.98 GB | 476 |
| 1e-6 (~111mm) | **hung — killed after 2+ minutes, no result** | — | — |

Non-monotonic and dangerous: the two finest values are a wash with baseline,
and the two coarsest — the values someone would naturally reach for first
to "snap harder" — are catastrophically worse or hang outright. Ruled out.

**Option 3 — pass an explicit `snap` tolerance to `ST_CoverageClean` instead
of `-1` (auto = `dataset_diameter / 1e8`).** Tested natively at five values:

| Explicit `snap` | Time | Peak memory |
|---|---|---|
| `-1` (auto ≈ 2.8e-8) | 17.76s | 2.13 GB |
| `1e-9` (finer) | 46.12s (2.6x slower) | 2.13 GB |
| `2.8e-8` (≈ auto) | 18.09s | 2.13 GB |
| `1e-7` | 17.40s | 2.16 GB |
| `1e-6` | 16.73s | 2.06 GB |
| `1e-5` (coarser) | **>120s — killed, never finished** | unknown |

Same shape as option 2: auto is already near-optimal, and no tested
alternative gives a real win; the coarser end hangs. Ruled out.

**Option 4 — raise `SET memory_limit` above DuckDB's auto-detected ~3.1
GiB default.** The setting *is* accepted (`current_setting('memory_limit')`
reports the new value, e.g. `7.4 GiB` after `SET memory_limit='8GB'`), and a
synthetic stress test (incompressible 6M-row table, ~1GB+ resident) succeeds
past the old default — so the config change isn't rejected outright. But
tested against the *actual* end-to-end failure (real `loadFile` →
`runFromLoaded` on the real 116MB file, via a temporary `window.__dbg` hook
added to `topology-cleaner/App.svelte` and reverted after testing), default
vs. raised produced **bit-for-bit identical timing and failure**:

| | Default (3.1 GiB) | Raised (7.4 GiB) |
|---|---|---|
| Reaches "Fixing topology" | 24.713s | 24.701s |
| Fails (OOM) | 58.486s | 58.451s |

`memory_limit` is DuckDB's own internal accounting threshold, not a real
memory grant — it has zero power over the browser's actual wasm32
`memory.grow()` ceiling. Definitively ruled out, not just "insufficient."

**Conclusion**: no lever tested makes `ST_CoverageClean` itself survive at
this data scale in WASM. The existing mitigation (export the pre-clean
result before attempting the clean, keep it if the clean fails — see
"Second real-world dataset: Burundi" above) is the correct behavior, not a
stopgap pending a real fix.

## Near-miss edges are pervasive, not a handful of seams

Prompted by the user loading Edge Matcher's Burundi Zone output into QGIS
and noticing "almost all the errors are gaps." Investigated as a possible
cheap alternative to `ST_CoverageClean`: if there are only a few genuine gap
defects, detecting them (already fast — `buildGapRegions`/
`buildOverlapRegions` in `topology-cleaner/pipeline/issues.ts` run independent
of `ST_CoverageClean` and only take ~1.2s) and fixing just those locally
(union each gap into its best neighbor) would sidestep the expensive global
graph algorithm entirely.

**First check ruled out true area defects.** Running the same
`gapRegionsQuery`/`overlapRegionsQuery` SQL from `issues.ts` natively against
the Burundi Zone matched output: **zero enclosed-area gaps, zero overlaps**,
at a threshold (1e-10 deg², ~1.2mm²) far finer than the app's own 1cm² noise
floor. Total union area matches the original input to full float64
precision (`2.176030274385891`), confirming no area is missing or
duplicated anywhere in the coverage.

**But `ST_CoverageInvalidEdges_Agg` (10m tolerance) does flag defects — a
lot of them.** 135,547 invalid edge segments, ~11.19° total length (~1,245
km), longest single segment ~1,018m. The original (pre-Edge-Matcher) source
data has 469 such edges totaling ~330m at the identical tolerance — roughly
**300x more edges and 3,800x more invalid length** in the derived output.
Size distribution: only 6,310 of the 135,547 are sub-1cm (plausible float
jitter); 84% (114,380) are >1m, and 33,134 exceed 10m, totaling ~879 km.
This is not floating-point noise — individual mismatches up to a kilometer
are a real, if benign (zero net area impact — see above), structural defect.

**A screenshot of the user's own QGIS Topology Checker confirmed the scale
directly**: 85,568 errors, all under its "gaps" rule, with red error markers
scattered essentially uniformly across the *entire interior* of the Burundi
coverage — not clustered at a few isolated cross-group seams as initially
assumed. Ruled out one candidate explanation before drawing conclusions: a
native check for whether the flagged edges cluster at the coverage's true
*exterior* perimeter (which by definition has no matching neighbor and could
be a validator false-positive, not a real defect) was attempted but the
query itself OOM'd natively (12.7 GiB) doing a buffered `ST_Within` test over
135K rows against one large exterior-ring buffer — inconclusive, not
retried with a cheaper formulation yet.

**Working hypothesis, not yet confirmed**: since total area is exactly
conserved (no true gap/overlap) yet tens of thousands of edges fail GEOS's
edge-matching, the two sides of a genuinely-coincident shared boundary are
likely being represented by *different vertex sequences along the same
line* — same geometric path, different sampling/density — rather than a
true positional offset. `ST_CoverageInvalidEdges_Agg` matches edges by
vertex-exact equality between rings, not by geometric coincidence, so two
polygons whose shared boundary traces an identical line but was independently
re-sampled (plausible given Edge Extender's per-cell Voronoi/point
interpolation, `layer_03`) would both get flagged as "unmatched" even
with zero true area defect.

### Confirmed: cross-group boundaries, not same-group boundaries, are the defect

Direct positive/negative-control test, both against real output data:

- **Negative control — same group.** `OGC_FID` 295 and 298 (group 28,
  "Ruyigi") genuinely touch along ~20,547m of boundary (confirmed via
  `ST_Touches` + measured shared-boundary length). `ST_CoverageInvalidEdges_Agg`
  over just this pair returns `NULL` — zero invalid edges. Same-group
  polygons come from one shared `runPipeline`/`ST_Union_Agg` dissolve pass
  (`stageMerge`), so their shared edges are vertex-identical by construction,
  as expected.
- **Positive control — cross group.** `OGC_FID` 31 (group 4, "Gisagara") and
  63 (group 7, "Ruyigi") border the single longest invalid edge in the whole
  dataset (~1,018m, centroid `30.5278, -3.3145`). The invalid edge's own
  vertices sit within 0.0–0.16mm of *both* polygons' boundaries (i.e. all
  three lines occupy essentially the same physical location), but each
  polygon samples that stretch at a different vertex density (261 pts/1799m
  vs. 151 pts/1878m nearby) — confirming "same line, different sampling," not
  a real positional offset.
  - **Caveat found while trying to reproduce this in isolation**: testing
    just this one pair (`ST_CoverageInvalidEdges_Agg` over a 2-row array
    containing only fid 31 and fid 63) reports **zero** invalid edges —
    it does *not* reproduce the defect found when the same pair is checked
    inside the full 465-row array. `ST_CoverageInvalidEdges_Agg`'s matching
    is apparently context-sensitive to the full candidate-neighbor set, not
    just a pairwise check; a 2-row subset is not a valid isolated repro for
    this class of check, unlike the noding-crash bugs elsewhere in this doc
    where per-fid isolation worked directly. All measurements of invalid-edge
    length in this investigation use the full 465-feature array.

**Root cause, confirmed**: each Edge Matcher group clips its own independent
Voronoi-derived output (`layer_05`) against its own parent polygon via
`clipToBoundary()`'s `ST_Intersection(a.geom, c.geom)`
(`src/lib/db/clipToBoundary.ts`). When a group's `layer_05` boundary fully
*overshoots* the parent boundary everywhere (the common case), the
intersection's boundary along that stretch is just `c.geom`'s own boundary,
verbatim — clean. But wherever a group's own extension *undershoots* the
parent boundary at some interior point (Voronoi cell didn't reach all the
way out, or Edge Extender's own residual `GAPS`/interior-ring artifacts —
see "Second bug class" above), GEOS has no choice but to use `a.geom`'s own
vertex there instead of `c.geom`'s — introducing a location-specific,
group-specific vertex that the *adjacent* group (clipping a differently-shaped
`layer_05` against a different parent polygon) has no way to agree with, even
though both groups' outputs pass through virtually the same physical point.
Two independent, unrelated per-group computations landing within millimeters
of each other by geometry, but never exactly, is exactly what
`ST_CoverageInvalidEdges_Agg` (and QGIS's Topology Checker) is built to flag.

### Two candidate fixes tested, both ruled out as sufficient on their own

**Tested: proactive `ST_ReducePrecision` snap, both sides, at the full-dataset
scale** (same mechanism as "Option 2" above, but measuring invalid-edge
*length*, not OOM timing — a different question). If the mismatch were mostly
sub-grid floating-point jitter, rounding both sides onto a shared coordinate
grid before checking should collapse most of it:

| Precision | Invalid edge length | Reduction | Total area |
|---|---|---|---|
| none (baseline) | 1,245,882 m | — | 2.176030274385891 |
| 1e-8 (~1mm) | 998,667 m | 20% | 2.176030273392548 |
| 1e-7 (~11mm) | 918,338 m | 26% | 2.176030273985414 |
| 1e-6 (~111mm) | 897,206 m | 28% | 2.176030282652497 |

Even at 111mm — a grid far coarser than acceptable for real admin boundary
data — 72% of the invalid length remains, and area has started measurably
drifting. **Ruled out as a sufficient fix**: this confirms the mismatch is
not primarily sub-grid rounding noise; it's a structural difference in the
actual vertex paths (different sampling density along a near-identical line),
which uniform rounding can't collapse unless the two paths already happen to
land in the same grid cell — evidently rare here.

**Tested: rebuild the parent/coarse layer from one globally-noded boundary
network**, so every parent polygon shares literal vertex identity with its
neighbors at the source (`ST_Node(ST_Union_Agg(ST_Boundary(geom)))` over all
43 communes once, `ST_Polygonize` back into per-commune polygons, reassigned
to original fids via `ST_PointOnSurface` + `ST_Intersects`). Validated against
the *original* Commune layer alone (COM_BURUNDI, 43 features) before ever
touching Edge Matcher's pipeline:

- Area conserved to float64 precision (`2.176030278914693` vs.
  `2.17603027891472`) — the rebuild is geometrically faithful.
- But: **43 input communes → 51 output pieces**, and invalid-edge length
  **increased** (163m vs. 81.5m baseline on the raw original commune layer).
  The naive point-in-polygon fid reassignment mis-partitions some communes
  into extra fragments (likely multi-part real features, or noding-introduced
  slivers, not yet distinguished), and those fragment boundaries introduce
  *new* invalid edges of their own. **Ruled out as implemented** — a real
  version of this idea would need a more robust fragment-to-fid reassignment
  than `ST_PointOnSurface`/`ST_Intersects` (e.g. largest-overlap-area
  matching, explicit multi-part handling) before it could be trusted, which
  is real, non-trivial engineering, not a quick fix.

### Forward-looking: `ST_Snap` (not yet available)

`ST_Snap(geom, target, tolerance)` — added to `duckdb-spatial` via
[PR #829](https://github.com/duckdb/duckdb-spatial/pull/829), merged
2026-06-26 — is the function this class of fix actually wants: snap `a.geom`
directly onto `c.geom`'s own vertices within a tolerance, without the
fragile Node+Polygonize+reassignment rebuild above. **Not usable yet**:
confirmed absent from the native `duckdb` CLI's spatial extension as
currently installed here (pinned at commit `b68b309`, predates the merge),
and `@duckdb/duckdb-wasm` (`^1.33.1-dev57.0`, per `package.json`) bundles its
own separately-versioned spatial extension build that would need to pick up
a release containing this commit. Worth re-testing `clipToBoundary.ts` with
real `ST_Snap(a.geom, c.geom, tolerance)` (snapping the derived side onto the
real parent boundary, before the `ST_Intersection` clip — same "never modify
real input" convention as the rest of this doc) once a spatial extension
release containing it is available, native or WASM. This wasn't evaluated
further this session — noted for later, not pursued now.

## Proposed fix: two endpoints, and which one to pick

**Endpoint A — fix it for real.** Build a properly-engineered version of the
canonical-boundary idea above (robust fragment reassignment, or wait for
`ST_Snap` and snap `layer_05` onto `coarse_layer_01` before every group's
clip) so adjacent groups' clipped edges become vertex-identical, driving the
135,547 invalid edges toward zero. Real engineering, uncertain payoff until
built — the one concrete attempt this session made the coarse layer's own
invalid-edge count *worse*, not better, so this is not a small patch.

**Endpoint B — accept and document it.** The defect has **zero measured
real-world cost**: total area is exactly conserved (confirmed to float64
precision, twice, on two different datasets), there are no true gaps or
overlaps (confirmed via `issues.ts`'s own gap/overlap queries at a
sub-mm² threshold), and the only consumers that notice are strict
vertex-exact validators (`ST_CoverageInvalidEdges_Agg`, QGIS's Topology
Checker) — not a correctness problem for anyone using the output as GIS data
normally. Proactively clean the coarse/parent input layer before matching
(cheap, real win: fixes the ~81m of pre-existing imprecision already present
in the raw Commune source data, independent of anything Edge Matcher does),
and document in the tool's UI/README that strict topology validators may
flag near-miss "gap" warnings at group boundaries despite verified-zero real
area defects — so users aren't alarmed by QGIS's Topology Checker the way
this investigation's user was.

**Recommendation: Endpoint B.** The evidence doesn't support Endpoint A being
cheap: the one fix idea that could plausibly reach zero (canonical rebuild)
needs real unbuilt engineering and made a naive first attempt *worse*, and
the other idea tested (uniform precision snap) tops out at a 28% reduction
even at an unacceptably coarse grid. Given the underlying data is already
provably correct (no missing/duplicated area, no real gaps/overlaps),
spending more engineering time chasing vertex-exact compliance with a
validator standard that has no bearing on the data's actual correctness is
not a good trade — versus a cheap, real, immediate win (clean the coarse
input) plus honest documentation of the known cosmetic limitation. Revisit
Endpoint A if `ST_Snap` becomes available and a user reports an actual
downstream breakage (not just a QGIS warning) traceable to this defect.

**Endpoint B's cheap win, implemented.** `src/lib/tools/match/pipeline/load.ts`'s
`loadLayers` now runs `gatedCoverageClean(conn, "parent_layer_01")` and
`gatedCoverageClean(conn, "child_layer_01")` right after loading, at default
settings (`snap=-1` auto, `gap=0` no gap-fill), same gated/preserve-fid-set
pattern already used elsewhere in this doc (`stageCleanInput`, the final
output clean). The parent layer was never cleaned anywhere in this pipeline
before; the child layer was only ever cleaned per-group, after splitting,
which misses defects between child units assigned to different groups.
Verified natively (this SQL doesn't touch any WASM-only code path, so native
verification is representative here, unlike the noding-crash bugs elsewhere
in this doc): on the real Burundi data, the parent (Commune, 43 features)
layer's own pre-existing 81.5m of invalid-edge length drops to exactly
**0m**, and the child (Zone, 465 features) layer's own pre-existing 328m
(consistent with the "469 edges/~330m" figure quoted earlier in this doc for
the original source data) drops to **133m** (60% reduction) — both with fid
count and total area preserved to float64 precision. This does **not**
address the much larger cross-group clip-introduced defect (135,547 edges,
1,245km) — that mechanism is untouched by cleaning the inputs, since it's
introduced downstream by the per-group clip step, not present in the raw
inputs. `npm run check` passes with this change. A live end-to-end browser
verification (driving the real `runEdgeMatch` pipeline via `window.__dbg`,
the same technique used throughout this doc) was attempted but not
completed cleanly — the shared `playwright-cli` browser instance was
repeatedly taken over by an unrelated concurrent process mid-run in this
session's environment, unrelated to this change. Worth a clean live rerun
when the environment is uncontended, though the native SQL-level
verification above already directly confirms the intended effect using the
identical query `gatedCoverageClean`/`buildCoverageClean` execute.

## Current state (as of this entry)

- `merge.ts`: dissolve via plain `ST_Union_Agg(geom)` (the `ST_BuildArea`/`ST_Node`
  reconstruction from fix #5 was reverted, see "Second bug class: silent area
  loss" above), wrapped in `withNodingRetry` (`src/lib/db/precisionRetry.ts`), 28
  candidates, 0.1mm–111mm. As of fix #12 (tiered restructure of fix #11), the
  retry is two-tiered: first sweep all 28 candidates reducing only the
  derived remainder (never the real input); only if that whole sweep is
  exhausted, escalate to a second 28-candidate sweep that also reduces the
  real-input row at the same value. A 155-candidate density experiment
  (fractional/non-decade-aligned spacings) found no benefit over the current
  28-value list — see "Tiered retry restructure, and a precision-density
  experiment" above — so the candidate list itself is unchanged.
- `clean.ts`, `index.ts`: back to original (pre-investigation) behavior — the
  unconditional-CoverageClean and stage-2 retry attempts were both reverted.
  `index.ts` also runs a single gated `ST_CoverageClean` on the true final
  output (see "Follow-up 2: consolidated to a single clean per batch").
- Temporary `[EE-DEBUG]` checkpoint logging is still present in `clean.ts`,
  `lines.ts`, `points.ts`, `voronoi.ts`, `merge.ts`, `index.ts`, `groups.ts` — left
  in place for continued investigation, not yet cleaned up. The `window.__dbg`
  debug hook now exists on **both** `edge-extender/App.svelte` and
  `match/App.svelte` (added to the former during the fix-#11 investigation).
- All previously-failing groups (La Pintada, Colon, Gualaca, Pinogana, Sambu,
  Capira; Santa Isabel via the whole-dataset monolithic-merge case) are now
  confirmed passing. No known failing case remains as of this entry.
- `clipToBoundary.ts`: `ST_Intersection` result now wrapped in
  `ST_CollectionExtract(geom, 3)` to guarantee polygon-only output — fixes
  the `GEOMETRYCOLLECTION` defect found on Burundi group 23 (see "Two more
  real bugs found" above).
- `loader.ts`: GeoJSON/GeoJSONL inputs now have any `OGC_FID` property
  renamed to `OGC_FID_orig` before registration, avoiding a collision with
  `ST_Read`'s own hardcoded synthetic `OGC_FID` FID column.
- Whole-batch `ST_CoverageClean` OOM on ~465-feature Burundi output is
  confirmed to be a hard WASM heap ceiling, independent of which tool/call
  site triggers it — reproduced identically standalone in Topology Cleaner.
  Not fixed (no code change makes `ST_CoverageClean` itself fit in 3 GiB at
  this scale); Edge Matcher's export-before-clean fallback (see "Second
  real-world dataset: Burundi" above) is the mitigation in place.

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
- [DONE] Whole-dataset monolithic-merge failure (Santa Isabel, PAN adm2 fid 14) —
  root-caused and fixed by reducing precision on both sides of the final
  dissolve union, not just the derived side. See fixes-table row #11 and the
  "New finding... (RESOLVED)" section above. Re-verified on both `/extend`
  (the originally-failing monolithic case) and `/match` (per-group, including
  the Santa Isabel group).
- [DONE] Tiered retry restructure (derived-only sweep first, escalate to
  both-sides only if exhausted) — implemented, fixes-table row #12.
- [DONE] Precision-density experiment (155 fractional/dense candidates vs.
  the current 28-value list) — no improvement found; failures are isolated
  single-point floating-point coincidences, not a region a denser/differently
  -spaced grid would avoid. `NODING_RETRY_PRECISIONS` left unchanged.
- [OPEN] Root-cause the 3 non-micro residual holes (188m/482m/2.2km) from the
  coverage-clean follow-up above — still not investigated.
- [IN PROGRESS] Once satisfied with the fix's stability across more real-world
  datasets (not just this one Panama file pair), remove the temporary
  `[EE-DEBUG]` checkpoint logging from `clean.ts`, `lines.ts`, `points.ts`,
  `voronoi.ts`, `merge.ts`, `index.ts`, `groups.ts`, and the `window.__dbg`
  debug hook from `edge-extender/App.svelte` and `match/App.svelte`. Not
  removed yet — clean runs on one dataset are a good signal, not full
  confidence; leaving the diagnostics in costs nothing and de-risks a second
  real-world test.
- [DONE] Second real-world dataset (Burundi) tested end-to-end on both tools
  — noding fixes hold, 0 crashes. Surfaced and fixed two new, unrelated bugs
  (loader `OGC_FID` collision, `clipToBoundary` `GEOMETRYCOLLECTION` output)
  and independently confirmed (via Topology Cleaner) that the whole-batch
  `ST_CoverageClean` OOM is a hard WASM ceiling, not fixable by relocating
  the call. See "Second real-world dataset: Burundi" section above.
- [DONE] Four candidate ways to make the whole-batch `ST_CoverageClean` OOM
  survivable were tried and ruled out, each with direct evidence — see "Four
  OOM-mitigation options tested and ruled out" below. None is viable;
  chunking the input by scoping to only seam-adjacent polygons was also
  considered and rejected *without* testing, on correctness grounds (see
  same section).
- [OPEN] Same `OGC_FID`-collision risk exists in principle for GPKG/SHP/KML/
  GML/GPX (binary/XML formats not covered by the loader fix, which only
  patches GeoJSON/GeoJSONL at the file-buffer level) — no repro yet for
  those formats, not fixed.
- [DONE] Root-caused *why* Edge Matcher's output has ~135,547 near-miss
  invalid edges (QGIS Topology Checker: 85,568 "gap" errors), vs. 469 in the
  original source data — see "Near-miss edges are pervasive, not a handful
  of seams" below. Confirmed via same-group (clean) vs. cross-group
  (defective) control pair: each group's independent per-group `ST_Intersection`
  clip (`clipToBoundary.ts`) introduces its own vertices at points where its
  Voronoi extension undershoots the parent boundary, and adjacent groups have
  no mechanism to agree on those points. Zero true area gaps/overlaps
  confirmed throughout — this is a vertex-sampling-density defect, not real
  missing/duplicated area.
- [DONE] Two candidate fixes tested and ruled out as insufficient: uniform
  `ST_ReducePrecision` snap (tops out at 28% invalid-length reduction even at
  an unacceptably coarse 111mm grid) and a naive canonical-boundary-network
  rebuild (made the coarse layer's own invalid-edge count *worse*, 163m vs.
  81.5m baseline, due to fragile fragment-to-fid reassignment). See "Two
  candidate fixes tested" above.
- [OPEN, not recommended for now] A properly-engineered canonical-boundary
  fix (robust fragment reassignment, or `ST_Snap` once available — see
  "Forward-looking: ST_Snap" above, merged upstream in duckdb-spatial PR #829
  but not yet in the native or WASM extension build used here) could drive
  the defect toward zero, but is real unbuilt engineering with unproven
  payoff. Recommendation (see "Proposed fix: two endpoints" above): don't
  pursue it now — the defect has zero measured real-world cost (area exactly
  conserved, no true gaps/overlaps).
- [DONE] Proactively clean both the coarse/parent AND fine/child input layers
  before matching (`match/pipeline/load.ts`) — cheap, real win, gated at
  default settings, verified natively (parent invalid-edge length 81.5m→0m,
  child 328m→133m, both with fid count/area preserved exactly). See
  "Endpoint B's cheap win, implemented" above.
- [OPEN] Document the cosmetic strict-validator limitation for users (UI copy
  or README) — not yet done.
