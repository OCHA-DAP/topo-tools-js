# schema

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema` shares with other tools.

`schema` is the Schema Crosswalk tool at `/schema`. It runs the `schema-map`
inference step (`docs/reference/schema-map.md`) and the `schema-refactor`
apply step (`docs/reference/schema-refactor.md`) on one page.

## Inputs

- `schema` MUST take exactly one polygon layer (query parameter `url`).
- `schema` MAY import a crosswalk CSV (query parameter `crosswalk`),
  parsed by `schema-refactor`'s crosswalk rules. Its targets MUST replace
  the inferred ones as the starting point for editing. Its input MUST be
  collapsed by default and open on load when `crosswalk` is set.
- An imported crosswalk whose `source_column` set does not match the layer MUST
  be reported with `schema-refactor`'s column-mismatch error, and the
  inferred crosswalk MUST be used instead.

## Mapping

- `schema` MUST infer the crosswalk with `schema-map`'s pipeline, unchanged.
- Editing the name or code template MUST re-run inference automatically,
  under `schema-map`'s template rules.
- A column with no inferred target MUST default to dropped, matching
  `schema-map`'s empty `target_column`.

## Editing

- Every row MUST have a keep checkbox and an editable target name. A checked
  row MUST rename the column to its target (its own name keeps it as is);
  an unchecked row MUST drop it and write an empty `target_column`.
- A row's target name MUST default to its inferred or imported target, else
  its source name, and MUST be retained while the row is unchecked.
- A header checkbox MUST check or uncheck every row, showing an
  indeterminate state when only some are checked.
- Edits MUST persist across re-inference, keyed by source column, until
  reset per row or all at once.
- A checked row with an empty target, or a duplicate or reserved target
  (`schema-refactor`'s rules), MUST be flagged on its row, and the crosswalk
  MUST NOT be applied or offered for download until every flagged row is
  fixed.

## Applying and outputs

- Every valid crosswalk state MUST be applied automatically with
  `schema-refactor`'s pipeline, unchanged.
- `schema` MUST offer the mapped layer (`schema-refactor`'s output, suffix
  `_mapped`) and the crosswalk CSV (`schema-map`'s output shape, suffix
  `_crosswalk`), both reflecting the current edits.
- The map MUST draw the loaded geometry once. Applying a crosswalk MUST NOT
  serialize geometry.
- Clicking a feature MUST show its source value on every row. With no
  feature selected, each row MUST show up to three sorted distinct sample
  values of its column.
- `schema` performs no topology check; nothing it runs touches geometry.

## Routes

- `/schema-map`, `/schema-refactor`, and `/schema-crosswalk` MUST redirect to
  `/schema`, preserving the query string.
