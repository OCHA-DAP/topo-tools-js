# stitch

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `stitch` shares with other tools.

## Inputs

- `stitch` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- `stitch` MUST NOT run `gatedCoverageClean` or any other clean pass on the
  input before stitching: whatever seams or defects the input has are
  exactly what the stitch pass exists to close.

## Stitching

- `stitch` MUST run one whole-table `ST_CoverageClean` pass over the
  input, at `SNAP_TOLERANCE` gap width and snapping distance — not a
  shape-based heuristic, and not user-configurable.
- The pass MUST preserve the input's fid set: a feature `ST_CoverageClean`
  collapses to empty MUST fall back to its pre-clean geometry rather than
  being dropped.

## Outputs

- `stitch` MUST export the cleaned layer.
- `stitch` MUST independently check the cleaned output for residual
  overlaps (warn-only, matching `extend`'s validation — see
  `docs/reference/extend.md`); `ST_CoverageClean` removing every overlap by
  construction means this SHOULD never fire.
- `stitch` MUST build a gap-only issues report from the cleaned output:
  every interior hole wider than `SNAP_TOLERANCE`, with `area_m2`,
  `max_width_m`, and `thinness_ratio` populated and every other column
  null, in the same schema `clean`'s issues table uses. A residual gap is
  not necessarily a defect — it may be a legitimate absence — so `stitch`
  MUST NOT raise on one, only report and warn-log it.
- `stitch` MUST offer the issues report as a separate download only when
  it has at least one row.

## Configuration

- `stitch` MUST process exactly one input file per run.
- `stitch` has no user-configurable gap-width or snapping parameter.
