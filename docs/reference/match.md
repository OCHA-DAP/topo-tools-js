# match

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md`/`docs/reference/extend.md` for rules `match` shares
with other tools.

## Inputs

- `match` MUST load the child (fine) layer and the parent (coarse) layer
  independently via the shared loader (see `docs/reference/shared.md`).
- `match` MUST run a gated whole-layer `gatedCoverageClean` pass over both
  the parent layer and the child layer immediately after loading, at
  default settings (auto snap, no gap-fill), before assignment — a defect
  between two child units later assigned to different groups would
  otherwise be invisible to any later per-group check.

## Assigning children to parents

- `match` MUST compute area-overlap pairs between every child and every
  bounding-box-nearby parent, via the shared overlap measurement contract
  (`docs/reference/shared.md`).
- `match` MUST assign each child to the single parent it shares the
  largest overlap area with (plurality, not necessarily more than half the
  child's own area).
- A tie between two candidate parents for the same child MUST be broken by
  the lower parent fid.
- A child with zero overlap with any parent MUST be recorded as
  unassigned, not silently dropped and not treated as fatal to the run.

## Per-group extension

- `match` MUST group assigned children by their parent, including a group
  of exactly one child, and MUST process only non-empty groups.
- For each group, `match` MUST populate `extend`'s pipeline with that
  group's own child subset and run it unmodified (see
  `docs/reference/extend.md`), with its own final `gatedCoverageClean` pass
  skipped — that pass is deferred to a single whole-batch pass after every
  group has run (see Assembly below).
- `match` MUST clip each group's extended result to that group's own known
  parent polygon (an exact-boundary clip, not another extension pass).
- A group whose extension or clip fails MUST be recorded as a failed group
  and skipped, without aborting the run. Every child belonging to a failed
  group MUST be treated the same as an unassigned child for reporting
  purposes.

## Assembly

- `match` MUST join every successfully clipped group's output into one
  combined result table before attempting any further cleanup.
- `match` MUST export the combined result from this already-clipped state
  BEFORE attempting a final whole-batch `gatedCoverageClean` pass, so that
  a failure of that final pass can never discard an already-correct,
  already-exportable result.
- `match` MUST attempt exactly one final `gatedCoverageClean` pass over the
  fully assembled batch, to catch cross-group boundary seams no per-group
  clip could see, and MUST only replace the pre-clean export with the
  post-clean one if that pass and its re-export both succeed.

## Outputs

- `match` MUST export the assembled, clipped result, plus a separate
  export of every unassigned child, available independently of the main
  result export.
- `match` MUST report, per group, whether it succeeded or failed, and MUST
  report the overlap-measurement method (`exact` or `sampling`) used for
  assignment.
- `match` MUST report the assembled result's bounding box for map fit,
  whenever the bounds are finite.

## Configuration

- `match` MUST process exactly one child file and one parent file per run.
- `match` has no user-configurable parameters — assignment, per-group
  extension, and final cleanup all run automatically once both files are
  loaded.
