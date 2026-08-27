# dissolve

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `dissolve` shares with other tools.

## Inputs

- `dissolve` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- `dissolve` MUST raise an error if the user runs it with an empty
  `group_by` selection.

## Dissolving

- `dissolve` MUST group rows by the exact column(s) in `group_by`, unioning
  their geometry per group with `ST_Union_Agg` followed by `ST_MakeValid`.
  A NULL value in a `group_by` column MUST form its own group like any
  other value (plain SQL `GROUP BY` semantics); `dissolve` MUST NOT raise
  or filter rows based on `group_by` nullness.
- Every column not in `group_by` MUST be resolved automatically: `dissolve`
  MUST check whether the column has at most one distinct value within
  every group, retaining it (`any_value`) if so and dropping it if not.
  There is no user-facing override for this decision.
- `dissolve` MUST report which columns were dropped, so the user can see
  why a column didn't survive into the output.

## Outputs

- `dissolve` MUST export the dissolved layer.
- `dissolve` MUST also build an issues report alongside it, using the
  shared schema in `docs/reference/shared.md`: one row per interior gap
  left in the dissolved output wider than `SNAP_TOLERANCE`, with
  `area_m2`, `max_width_m`, and `thinness_ratio` populated and every other
  column null/absent. `dissolve` MUST NOT raise on a leftover gap, only
  report it; it MUST offer the issues report as a separate download only
  when it has at least one row.

## Configuration

- `dissolve` MUST process exactly one input file per run.
- `group_by` MUST be a non-empty set of column names drawn from the
  loaded layer's own schema; `dissolve` has no other user-configurable
  column-selection surface (no keep/exclude/aggregate-function override).
