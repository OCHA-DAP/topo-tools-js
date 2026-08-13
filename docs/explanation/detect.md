# Detect

Scans a single polygon layer for gap/overlap coverage defects and reports
them, without fixing anything. The gap/overlap region-building and
issue-row assembly are the same shared logic Topology Cleaner's own
detection stage uses (`$lib/db/issues.ts`), exposed here as a standalone,
read-only tool with no reclean loop. Ported from topo-tools-py's `detect`
(`docs/explanation/detect.md` there), which extracted the same logic out of
`clean`'s own issue-detection stage for the same reason.

## Pipeline

1. **Load** — the shared loader (`$lib/db/loader`), no pre-clean: `detect`'s
   whole purpose is to report defects in the raw input, so the detection
   stage needs to see them, not a table `ST_CoverageClean` has already
   silently rewritten.
2. **Detect** (`pipeline/index.ts`, via `$lib/db/issues`'s
   `buildGapRegions`/`buildOverlapRegions`) — gap detection always runs;
   overlap detection is skipped (reported as zero) whenever the input
   already has no coverage violations (`hasCoverageViolations`), matching
   Topology Cleaner's own skip-gate (ADR-0019): a coverage with no invalid
   edges cannot contain an overlapping or nested pair either, and gap
   detection has no equivalently cheap pre-check.
3. **Assemble** (`$lib/db/issues`'s `assembleIssues`) — unions the gap and
   overlap region tables into one issues table and derives the row list +
   map GeoJSON from it. Unlike Topology Cleaner, this is the tool's only
   output — there is no cleaned layer, and the report is produced
   unconditionally, even when it has zero rows.

Each detection query degrades to an empty result (logged) on a GEOS
failure rather than aborting the whole run — one kind's failure doesn't
block the other, surfaced in the UI as a per-kind "detection failed"
warning rather than a false "0 defects."

## Issues table schema

`key, kind, area_m2, max_width_m, thinness_ratio, unit_a, unit_b, geom` —
the same shape Topology Cleaner's own issues table uses, minus the
reclean-loop-only columns (`fixed`, `filled_area_m2`,
`unit_a_area_change_m2`, `unit_b_area_change_m2`): `detect` never fixes
anything, so those columns don't apply. `kind` is `gap` or `overlap`;
`thinness_ratio` is populated only for gap rows, `unit_a`/`unit_b` (the two
fids involved) only for overlap rows.

## No noise floor

Unlike Topology Cleaner's Minimal/Thin/All gap-fill modes, `detect` reports
every gap and overlap it finds regardless of size — there is no
`SNAP_TOLERANCE` filter here, since nothing is being filled. Distinguishing
a real defect from floating-point noise is left to the person reading the
report.

## Relationship to Topology Cleaner

Topology Cleaner uses this same shared detection logic as the first stage
of an interactive fix loop. `detect` is the same detection logic exposed on
its own, for inspecting a coverage without committing to any fix.
