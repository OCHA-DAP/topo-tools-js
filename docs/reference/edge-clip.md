# edge-clip

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `edge-clip` shares with other tools.

## Inputs

- `edge-clip` MUST load the input layer and the overlay layer
  independently via the shared loader (see `docs/reference/shared.md`),
  without running `gatedCoverageClean` or any other clean pass on either
  layer — whatever seams remain between clipped pieces are `edge-stitch`'s job
  downstream, not `edge-clip`'s.
- `edge-clip` MAY load an original layer (the input before extension) the
  same way, used only to decide clip-detached pieces (see Clipping).

## Assigning input polygons to an overlay polygon

- `edge-clip` MUST assign every input polygon to the one overlay polygon that wins a
  majority vote by count across the whole input upload: the overlay polygon
  overlapping the most distinct input polygons, not the overlay polygon any single input polygon
  overlaps most (assign-one, distinct from `edge-match`'s per-input-polygon plurality
  assign-many — see `docs/explanation/edge-clip.md`).
- A tie in the vote MUST be broken by the lower overlay polygon fid.
- `edge-clip` MUST assign every input polygon to the winning overlay polygon,
  including one that does not overlap it, never to a different overlay
  polygon. Such a polygon clips to empty (see Clipping).
- If no input polygon overlaps any overlay polygon at all, `edge-clip` MUST fail the run
  rather than produce an empty result.
- `edge-clip` MAY accept a code-based assignment override, evaluated per file
  (assign-one); see `docs/reference/shared.md`'s "Code-based assignment
  override" section and `docs/adr/0029`.

## Clipping

- `edge-clip` MUST clip every assigned input polygon to exactly the winning overlay polygon
  unit's own geometry via geometric intersection.
- An overlay polygon boundary whose vertex count exceeds the shared adaptive tiling
  threshold MUST be grid-subdivided into tiles before intersecting, joined
  to input polygons via a bounding-box prefilter rather than a direct spatial
  join, matching the tiling behavior `docs/explanation/performance.md`
  documents for other tools.
- An assigned input polygon whose clipped result is empty MUST be dropped from the
  output, not exported as an empty geometry.
- `edge-clip` MUST fail the run if the clipped result has zero rows.
- `edge-clip` MUST merge or keep every clip-detached piece in the clipped
  result (see `docs/reference/shared.md`), recording each as a
  `detached-part` row, before the micro-polygon merge.
- `edge-clip` MUST merge or drop every micro-polygon in the clipped result (see
  `docs/reference/shared.md`), recording each as a `micro-polygon` row.

## Outputs

- `edge-clip` performs no topology hard gate on its output; that check is
  `edge-stitch`'s job on the assembled result, not `edge-clip`'s.
- `edge-clip` MUST report the winning overlay polygon's fid, the count of input polygons
  assigned to it, the count that overlap it, and the count dropped for
  clipping empty.
- `edge-clip` MUST produce an issues report whenever it has at least one row,
  combining every input polygon left unassigned because no overlay polygon
  won (`kind='unassigned'`) with every assigned input polygon whose clip result came
  out empty (`kind='clip-empty'`, `reason`
  `clip intersection with its overlay polygon was empty`), every merged or
  kept clip-detached piece (`kind='detached-part'`), every merged
  or dropped micro-polygon (`kind='micro-polygon'`), plus any
  `code-mismatch`/`code-fallback`
  row from a supplied code-based assignment override (see
  `docs/reference/shared.md`).

## Configuration

- `edge-clip` MUST process exactly one input file and one overlay file per
  run (see `docs/adr/0026` for why: this app's upload model has no concept
  of multiple independently-voted input files in one run).
- `edge-clip` MAY accept one original layer file (`original` URL param).
- `edge-clip` MAY accept a `matchColumn` name or a
  `overlayMatchColumn`/`inputMatchColumn` pair for the code-based
  assignment override (see `docs/adr/0029`).
- `edge-clip` MAY accept a list of overlay polygon attribute columns to carry into
  the output, the same contract as `edge-mosaic`'s (see `docs/reference/edge-mosaic.md`):
  each joined onto every output row, under its own name, from the single
  winning overlay polygon's own attribute row. A carried column whose name
  already exists on the input layer MUST raise.
