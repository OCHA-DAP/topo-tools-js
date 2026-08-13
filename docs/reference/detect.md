# detect

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `detect` shares with other tools.

## Inputs

- `detect` MUST read the input via the shared loader (see
  `docs/reference/shared.md`), without running `gatedCoverageClean` or any
  other clean pass first, so the detection stage sees the original,
  unmodified geometry.

## Detecting gaps and overlaps

- `detect` MUST report every fully-enclosed hole in the combined shape of
  all input polygons as a gap, regardless of its size. An open,
  non-enclosed inlet between two polygons MUST NOT be reported as a gap.
- `detect` MUST report every case where two polygons' interiors genuinely
  overlap, or one fully contains the other, as an overlap, regardless of
  its size, whenever the input has any coverage violation at all. If the
  input has no coverage violations, `detect` MUST report zero overlaps
  without running the overlap check. Two polygons that only share a
  boundary edge MUST NOT be reported as an overlap.
- If detecting one kind of defect fails, `detect` MUST still report the
  other kind rather than failing entirely.
- The issues report MUST list, for every defect: a unique key, whether it
  is a gap or an overlap, its area, its max width, and its geometry. A gap
  entry MUST also carry a thinness ratio; an overlap entry MUST also
  identify the two units involved. Neither MUST appear on the other kind's
  entries.

## Outputs

- `detect` performs no topology hard gate at all; it is a read-only
  inspection, not a fix.
- `detect` MUST always produce an issues report, even when the input had
  zero defects.

## Configuration

- `detect` MUST process exactly one input file per run.
- `detect` has no user-configurable parameters.
