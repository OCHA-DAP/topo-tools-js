# clean

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `clean` shares with other tools.

## Inputs

- `clean` MUST read the input and reproject it via the shared loader (see
  `docs/reference/shared.md`) without correcting any topology defect first,
  so the issues stage sees the original, unmodified geometry.
- `clean` MUST freeze the loaded input into an array shape once per load
  (`buildInput`) and MUST cache whether that input has any coverage
  violation (`inputHasViolations`), reusing both across every reclean
  triggered by the gap-width slider rather than recomputing them.

## Detecting gaps and overlaps

- `clean` MUST report every fully-enclosed hole in the union of all input
  polygons as a gap, regardless of its size. An open, non-enclosed inlet
  between two polygons MUST NOT be reported as a gap.
- `clean` MUST report every case where two polygons' interiors genuinely
  overlap, or one fully contains the other, as an overlap, regardless of
  its size. Two polygons that only share a boundary edge MUST NOT be
  reported as an overlap.
- The overlap join MUST use a bounding-box prefilter combined with
  `ST_Overlaps`/`ST_Contains`, not a bare `ST_Intersects`, so that ordinary
  touching-edge pairs (the normal case for adjacent polygons in a real
  coverage) never enter the candidate set.
- If detecting one kind of defect fails (a GEOS overlay error), `clean`
  MUST degrade that kind to an empty result and still report the other
  kind, rather than aborting the whole run. The degraded kind MUST be
  distinguishable, in the result, from a kind that genuinely found zero
  issues.
- Each issue row MUST carry a stable key, its kind (`gap` or `overlap`),
  its area, and its maximum width (`ST_MaximumInscribedCircle` diameter). A
  gap row MUST also carry a Polsby-Popper compactness ratio
  (`4·π·Area / Perimeter²`). An overlap row MUST also identify the two
  units involved. Neither MUST appear on the other kind's rows.

## Gap-fill modes

- The default mode (`auto`) MUST fill a gap only when its compactness
  ratio is at or below `0.3` (a digitization-sliver shape), and MUST set
  the fill width to twice the widest such gap's maximum width, rounded up
  to a nice number (1/2/5 × 10^k).
- The `all` mode MUST use the same width formula but MUST consider every
  detected gap regardless of shape.
- The `manual` mode MUST use the width the user supplies directly, with no
  shape filtering.
- Either `auto` or `all` MAY resolve to a width of `0` when no gap
  qualifies, meaning no gap is filled.

## Fixing topology

- `clean` MUST skip `ST_CoverageClean` entirely and copy the input straight
  through when the cached violations check is false and the resolved
  gap-fill width is `0`.
- Otherwise, `clean` MUST run `ST_CoverageClean` exactly once, with
  automatic snapping (`snap = -1`) and the resolved gap-fill width, over
  the frozen input array.
- `clean` MUST NOT apply a precision-reduction retry to a `ST_CoverageClean`
  failure on real input geometry.

## Outputs

- `clean` MUST independently re-run gap/overlap detection, plus an
  `ST_IsValid` sweep, against the exported table itself (not just the
  pre-clean input) after every clean or reclean, and MUST report the
  result as a distinct "export check," separate from the original issues
  list.
- `clean` MUST report, for every originally-detected issue, whether it
  ended up resolved in the current cleaned output: an overlap MUST always
  count as resolved; a gap MUST count as resolved only if a representative
  interior point of the gap is now covered by some polygon in the cleaned
  output.
- `clean` MUST report a collapsed-feature count (input row count minus
  surviving cleaned row count) whenever a clean or reclean runs.
- Neither an unfilled gap, nor the export check finding a residual defect,
  MUST raise or abort — `clean` MUST always still produce a cleaned output
  and an issues report, and MUST surface the export check's findings for
  display instead.

## Configuration (UI)

- The gap-width control MUST accept meters and MUST be converted to
  degrees using the dataset's own centroid latitude (`cos(latitude)`
  scaling), not a fixed conversion factor.
- Changing the gap-width slider MUST trigger only a reclean (`buildClean`
  + `checkFixedIssues` + export-check), reusing the cached input freeze
  and the cached issues list, never re-running gap/overlap detection.
