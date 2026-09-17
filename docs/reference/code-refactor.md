# code-refactor

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `code-refactor` shares with other
tools, including the "Hierarchical code format and retention" section it
shares with `code-update`.

## Inputs

- `code-refactor` MUST accept exactly one input, loaded via the shared
  loader. It performs no topology gate and never touches geometry, only
  attribute columns.

## Level resolution

- `code-refactor` MUST resolve each level's own code column either via an
  explicit name/code field template pair (each containing a `{n}`
  placeholder, given together or not at all, raising if only one is given),
  or, when both are omitted, via structural auto-detection
  (`schema-map`'s `detectLevelColumnsOrSingle`, cardinality/containment
  only, no naming convention assumed).
- `code-refactor` MUST raise if structural auto-detection finds zero
  levels.
- `code-refactor` MUST raise if any resolved level has no existing code
  column to overwrite, rather than silently skipping that level.
- Every resolved level MUST be renumbered to a clean, relative `1..N`
  sequence, coarsest first; a genuinely constant coarsest column is
  dropped before reaching this step and never becomes a level.
- A source column that never resolves into a level MUST be left
  completely untouched: `code-refactor` never stamps the root code into
  its own output column, it's used only as the literal parent for level
  1's own assignment.

## Assignment

- For each resolved level `1..N`, ascending, `code-refactor` MUST rank
  that level's own distinct code-column values under their
  immediately-coarser level's already-assigned code (or the root code,
  for level 1), sorted by their own raw, pre-assignment value, and
  overwrite the column in place with a freshly assigned, sequential,
  zero-padded code (`assignNewCodes`, see `docs/reference/shared.md`).
- A level's raw source value MUST NOT be reused as-is: it may be
  non-numeric, gappy, or duplicated across siblings, so every value is
  always re-ranked into a fresh sequential integer before formatting.
- A parent whose child count exceeds `10 ** minWidth - 1` (999 at the
  default width 3) MUST NOT have its already-assigned, lower-numbered
  children's codes repadded; the overflowing child's own tail simply
  grows past `minWidth` instead.

## Outputs

- `code-refactor` MUST export the finest-level table, every resolved
  level's code column overwritten in place, as the main output.
- `code-refactor` MUST always write an overflow issues table
  (`cr_issues`), empty when no parent exceeded capacity. Schema: `kind`
  (`'digit-overflow'`), `level`, `parent_code`, `assigned_code` (the
  overflowing parent's own highest-tail-integer child), `child_count`,
  `min_width`, `reason`.

## Configuration

- `code-refactor` MUST process exactly one input file per run.
- Root code, delimiter, and min width MUST all be given explicitly (no
  default), validated via `resolveCodeFormat`: root code non-empty,
  delimiter exactly one character, min width positive. The root code is
  opaque, never shape-checked.
