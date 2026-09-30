# edge-mosaic

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md`/`docs/reference/edge-clip.md`/`docs/reference/edge-stitch.md`
for rules `edge-mosaic` shares with other tools.

## Inputs

- `edge-mosaic` MUST load the input layer and the overlay layer
  independently via the shared loader, without running `gatedCoverageClean`
  or any other clean pass on either — same as `edge-clip`.
- `edge-mosaic` MUST NOT re-run Voronoi extension on any input feature; the input features
  layer is expected to already be a finished Edge Extender output, though
  `edge-mosaic` never verifies this.
- `edge-mosaic` MUST process exactly one input file and one overlay file per
  run (see `docs/adr/0026`, which this tool shares with `edge-clip`).

## Assigning and clipping

- `edge-mosaic`'s assign and clip stages MUST behave exactly as `edge-clip`'s own
  (`docs/reference/edge-clip.md`): assign-one majority vote with every input
  feature assigned to the winner, adaptively grid-tile a large overlay feature
  boundary, drop any assigned input feature whose clip result is empty, and fail
  the run if no overlay feature wins.

## Stitching

- `edge-mosaic` MUST run one whole-table coverage-clean pass over the clipped
  result, per `docs/reference/edge-stitch.md`, at the same `SNAP_TOLERANCE`
  gap-closing width `edge-stitch` uses on its own.

## Outputs

- `edge-mosaic` performs no hard topology gate that blocks export; a residual
  overlap or gap after the stitch pass is reported, not raised (see
  `docs/adr/0027`).
- `edge-mosaic` MUST export the final stitched layer.
- `edge-mosaic` MUST also produce a combined issues report listing every input feature
  that never made it into the final output, identified by its own fid (kind
  `unassigned` when no overlay feature won, `clip-empty` when its clip came
  out empty), every leftover gap the stitch pass's own issues check
  finds (kind `gap`), every micro-polygon the stitch pass merged or
  dropped (kind `micro-polygon`), and any `code-mismatch`/`code-fallback` rows from a
  supplied code-based assignment override (see `docs/reference/edge-clip.md`,
  `docs/reference/shared.md`), and MUST produce it only when it has at
  least one row.

## Configuration

- `edge-mosaic` MAY accept a `matchColumn` name or a
  `overlayMatchColumn`/`inputMatchColumn` pair for the code-based
  assignment override (see `docs/adr/0029`).
- `edge-mosaic` MAY accept a list of overlay feature attribute columns to carry into the
  output, each joined onto every output row, under its own name, from the
  single winning overlay feature's own attribute row. A carried column whose
  name already exists on the input layer MUST raise.
