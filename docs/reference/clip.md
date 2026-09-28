# clip

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `clip` shares with other tools.

## Inputs

- `clip` MUST load the input layer and the overlay layer
  independently via the shared loader (see `docs/reference/shared.md`),
  without running `gatedCoverageClean` or any other clean pass on either
  layer — whatever seams remain between clipped pieces are `stitch`'s job
  downstream, not `clip`'s.

## Assigning input features to an overlay feature

- `clip` MUST assign every input feature to the one overlay feature that wins a
  majority vote by count across the whole input upload: the overlay feature
  overlapping the most distinct input features, not the overlay feature any single input feature
  overlaps most (assign-one, distinct from `match`'s per-input-feature plurality
  assign-many — see `docs/explanation/clip.md`).
- A tie in the vote MUST be broken by the lower overlay feature fid.
- An input feature that does not overlap the winning overlay feature MUST be dropped
  from the run, not clipped against a different overlay feature.
- If no input feature overlaps any overlay feature at all, `clip` MUST fail the run
  rather than produce an empty result.
- `clip` MAY accept a code-based assignment override, evaluated per file
  (assign-one); see `docs/reference/shared.md`'s "Code-based assignment
  override" section and `docs/adr/0029`.

## Clipping

- `clip` MUST clip every assigned input feature to exactly the winning overlay feature
  unit's own geometry via geometric intersection.
- An overlay feature boundary whose vertex count exceeds the shared adaptive tiling
  threshold MUST be grid-subdivided into tiles before intersecting, joined
  to input features via a bounding-box prefilter rather than a direct spatial
  join, matching the tiling behavior `docs/explanation/performance.md`
  documents for other tools.
- An assigned input feature whose clipped result is empty MUST be dropped from the
  output, not exported as an empty geometry.
- `clip` MUST fail the run if the clipped result has zero rows.

## Outputs

- `clip` performs no topology hard gate on its output; that check is
  `stitch`'s job on the assembled result, not `clip`'s.
- `clip` MUST report the winning overlay feature's fid, the count of input features
  assigned to it, the count dropped for not overlapping it, and the count
  dropped for clipping empty.
- `clip` MUST produce an issues report whenever it has at least one row,
  combining every input feature dropped for not overlapping the winning overlay feature
  (`kind='unassigned'`) with every assigned input feature whose clip result came
  out empty (`kind='clip-empty'`, `reason` `clip intersection with its
  overlay feature was empty`), plus any `code-mismatch`/`code-fallback`
  row from a supplied code-based assignment override (see
  `docs/reference/shared.md`).

## Configuration

- `clip` MUST process exactly one input file and one overlay file per
  run (see `docs/adr/0026` for why: this app's upload model has no concept
  of multiple independently-voted input files in one run).
- `clip` MAY accept a `matchColumn` name or a
  `overlayMatchColumn`/`inputMatchColumn` pair for the code-based
  assignment override (see `docs/adr/0029`); it has no other
  user-configurable parameters.
