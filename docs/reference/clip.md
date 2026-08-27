# clip

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `clip` shares with other tools.

## Inputs

- `clip` MUST load the children layer and the parent/clip layer
  independently via the shared loader (see `docs/reference/shared.md`),
  without running `gatedCoverageClean` or any other clean pass on either
  layer — whatever seams remain between clipped pieces are `stitch`'s job
  downstream, not `clip`'s.

## Assigning children to a parent unit

- `clip` MUST assign every child to the one parent unit that wins a
  majority vote by count across the whole children upload: the parent
  overlapping the most distinct children, not the parent any single child
  overlaps most (assign-one, distinct from `match`'s per-child plurality
  assign-many — see `docs/explanation/clip.md`).
- A tie in the vote MUST be broken by the lower parent fid.
- A child that does not overlap the winning parent unit MUST be dropped
  from the run, not clipped against a different parent.
- If no child overlaps any parent unit at all, `clip` MUST fail the run
  rather than produce an empty result.
- `clip` MAY accept a code-based assignment override, evaluated per file
  (assign-one); see `docs/reference/shared.md`'s "Code-based assignment
  override" section and `docs/adr/0029`.

## Clipping

- `clip` MUST clip every assigned child to exactly the winning parent
  unit's own geometry via geometric intersection.
- A parent boundary whose vertex count exceeds the shared adaptive tiling
  threshold MUST be grid-subdivided into tiles before intersecting, joined
  to children via a bounding-box prefilter rather than a direct spatial
  join, matching the tiling behavior `docs/explanation/performance.md`
  documents for other tools.
- An assigned child whose clipped result is empty MUST be dropped from the
  output, not exported as an empty geometry.
- `clip` MUST fail the run if the clipped result has zero rows.

## Outputs

- `clip` performs no topology hard gate on its output; that check is
  `stitch`'s job on the assembled result, not `clip`'s.
- `clip` MUST report the winning parent's fid, the count of children
  assigned to it, the count dropped for not overlapping it, and the count
  dropped for clipping empty.
- `clip` MUST produce an issues report whenever it has at least one row,
  combining every child dropped for not overlapping the winning parent
  (`kind='unassigned'`) with every assigned child whose clip result came
  out empty (`kind='clip-empty'`), plus any `code-mismatch`/`code-fallback`
  row from a supplied code-based assignment override (see
  `docs/reference/shared.md`).

## Configuration

- `clip` MUST process exactly one children file and one parent file per
  run (see `docs/adr/0026` for why: this app's upload model has no concept
  of multiple independently-voted children files in one run).
- `clip` MAY accept a `matchColumn` name or a
  `parentMatchColumn`/`childMatchColumn` pair for the code-based
  assignment override (see `docs/adr/0029`); it has no other
  user-configurable parameters.
