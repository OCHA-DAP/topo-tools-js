# mosaic

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md`/`docs/reference/clip.md`/`docs/reference/stitch.md`
for rules `mosaic` shares with other tools.

## Inputs

- `mosaic` MUST load the children layer and the parent/clip layer
  independently via the shared loader, without running `gatedCoverageClean`
  or any other clean pass on either — same as `clip`.
- `mosaic` MUST NOT re-run Voronoi extension on any child; the children
  layer is expected to already be a finished Edge Extender output, though
  `mosaic` never verifies this.
- `mosaic` MUST process exactly one children file and one parent file per
  run (see `docs/adr/0026`, which this tool shares with `clip`).

## Assigning and clipping

- `mosaic`'s assign and clip stages MUST behave exactly as `clip`'s own
  (`docs/reference/clip.md`): assign-one majority vote, drop children not
  overlapping the winning parent, adaptively grid-tile a large parent
  boundary, drop any assigned child whose clip result is empty, and fail
  the run if zero children were ever assigned.

## Stitching

- `mosaic` MUST run one whole-table coverage-clean pass over the clipped
  result, per `docs/reference/stitch.md`, at the same `SNAP_TOLERANCE`
  gap-closing width `stitch` uses on its own.

## Outputs

- `mosaic` performs no hard topology gate that blocks export; a residual
  overlap or gap after the stitch pass is reported, not raised (see
  `docs/adr/0027`).
- `mosaic` MUST export the final stitched layer.
- `mosaic` MUST also produce a combined issues report listing every child
  that never made it into the final output (kind `unassigned`, identified
  by its own fid) and every leftover gap the stitch pass's own issues
  check finds (kind `gap`), and MUST produce it only when it has at least
  one row.

## Configuration

- `mosaic` has no user-configurable parameters.
