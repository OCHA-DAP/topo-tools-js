# topo-detect

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `topo-detect` shares with other tools.

## Inputs

- `topo-detect` MUST read the input via the shared loader (see
  `docs/reference/shared.md`), without running `gatedCoverageClean` or any
  other clean pass first, so the detection stage sees the original,
  unmodified geometry.

## Detecting gaps, overlaps, micro-polygons and notches

- `topo-detect` MUST report every fully-enclosed hole in the combined shape of
  all input polygons as a gap, regardless of its size. An open,
  non-enclosed inlet between two polygons MUST NOT be reported as a gap.
- `topo-detect` MUST report every case where two polygons' interiors genuinely
  overlap, or one fully contains the other, as an overlap, regardless of
  its size, whenever the input has any coverage violation at all. If the
  input has no coverage violations, `topo-detect` MUST report zero overlaps
  without running the overlap check. Two polygons that only share a
  boundary edge MUST NOT be reported as an overlap.
- `topo-detect` MUST report every micro-polygon part (see
  `docs/reference/shared.md`) as a `micro-polygon`, identifying the unit
  it belongs to, without fixing it.
- `topo-detect` MUST report every notch (see `docs/reference/shared.md`) as a
  `notch`, identifying both units, with `near_length_m` set to the score
  times `NOTCH_SPACING` in metres and area and width left null. A notch that
  intersects a detected gap, or an overlap between the same two units, MUST
  NOT be reported, and the remaining notches keep their keys. `topo-clean`'s
  issues report applies the same rule, and closing still acts on every notch.
- If detecting one kind of defect fails, `topo-detect` MUST still report the
  other kinds rather than failing entirely.
- The issues report MUST list, for every defect: a unique key, its kind
  (gap, overlap, micro-polygon or notch), its area, its max width, and its geometry. A gap
  entry MUST also carry a thinness ratio; an overlap entry MUST also
  identify the two units involved. Neither MUST appear on the other kind's
  entries.

## Outputs

- `topo-detect` performs no topology hard gate at all; it is a read-only
  inspection, not a fix.
- `topo-detect` MUST always produce an issues report, even when the input had
  zero defects.

## Configuration

- `topo-detect` MUST process exactly one input file per run.
- `topo-detect` has no user-configurable parameters.
