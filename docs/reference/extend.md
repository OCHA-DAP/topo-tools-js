# extend

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `extend` shares with other tools.

## Inputs

- `extend` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- If the loaded input has any coverage violation (an overlap or a
  mismatched shared edge), `extend` MUST correct it via `gatedCoverageClean`
  before continuing; otherwise it MUST leave the input unmodified.
- Correcting a violation MAY shift any polygon's boundary, not just the
  violating one.
- `extend` MUST NOT distinguish a real hole from a digitization gap at this
  stage — both are left for the boundary-extension algorithm to close.

## Extracting boundaries

- Each polygon's exterior boundary MUST be its own boundary minus the
  combined boundary of every bounding-box-overlapping neighbor. A polygon
  with no such neighbor MUST keep its full boundary.
- The neighbor-union join MUST use bounding-box predicates rather than a
  bare spatial predicate, per `docs/reference/shared.md`'s `SPATIAL_JOIN`
  rule.

## Generating points and the Voronoi diagram (retried together)

- `extend` MUST generate points along each polygon's exterior boundary, as
  input to a Voronoi diagram, at a target spacing derived once per input
  (`computeEffectiveDistance`): the smaller of a fixed default and the
  file's own median real-segment length.
- A single real segment MUST NOT contribute more than a fixed cap's worth
  of interpolated points, independent of the resolved spacing.
- Generated points MUST exclude a buffered zone around every shared
  boundary endpoint, so junction vertices don't become redundant Voronoi
  generators.
- `extend` MUST build a Voronoi diagram from the generated points, assign
  each cell to the polygon whose point generated it via a point-in-polygon
  join, and union cells by polygon into that polygon's extension.
- `extend` MUST verify every generator point was assigned to a Voronoi
  cell; an incomplete assignment MUST be treated as a failure of this
  stage, not silently accepted.
- On a failure of point generation or Voronoi assignment, or a generated
  point count exceeding a fixed maximum, `extend` MUST retry with the
  resolved spacing doubled, up to 10 attempts, then MUST raise, reporting
  which stage and spacing last failed.

## Merging

- Each polygon's final geometry MUST be its original geometry combined
  with the portion of its own Voronoi extension not already covered by a
  bounding-box-nearby original polygon.
- Before differencing, a polygon's Voronoi extension MUST be snapped
  (`ST_Snap`, a fixed small tolerance) to the union of its bounding-box-
  nearby neighbors, so near-but-not-quite-coincident seams from Voronoi
  cell generation don't cause a GEOS noding failure on the subsequent
  difference. A noding failure that survives the snap MUST propagate as a
  normal pipeline error, not be retried.
- `extend` MUST run the shared no-erosion guard (`docs/reference/shared.md`)
  against the merged result, before the final clean pass below, comparing
  it to the loaded-and-normalized input, and MUST treat a violation as a
  hard failure of the run.
- `extend` MUST run one whole-layer `gatedCoverageClean` pass over the
  merged result, using a fixed gap-closing width, unless the caller
  explicitly requests skipping it (see `match`'s per-group use).

## Outputs

- `extend`'s final output SHOULD have no overlap and no gap after the
  merge stage's `gatedCoverageClean` pass; `extend` MUST run an
  independent, warn-only validation sweep (overlap check, gap check, row-
  count-vs-input check) afterward and MUST log any residual defect rather
  than raising.
- `extend` MUST export the final merged layer, plus its computed bounding
  box for map fit, whenever the bounds are finite.

## Configuration

- `extend` MUST process exactly one input file per run.
- `extend` has no user-configurable point-spacing or snapping parameter;
  the target spacing is always derived automatically (see "Generating
  points" above).
