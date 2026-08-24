# schema-crosswalk

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-crosswalk` shares with other tools.

## Mapping and applying

- `schema-crosswalk` MUST take exactly one polygon layer as input, no
  crosswalk CSV upload.
- `schema-crosswalk` MUST map a source-column -> target-schema crosswalk
  exactly as standalone `schema-map` does (see `docs/reference/schema-map.md`):
  the same matching passes, noise-column exclusion, and output ordering
  rules apply unchanged, by calling `schema-map`'s own pipeline function
  directly rather than owning separate logic.
- `schema-crosswalk` MUST then apply that freshly-generated crosswalk
  exactly as standalone `schema-refactor` does (see
  `docs/reference/schema-refactor.md`): the same coverage-validation,
  renaming, and dropping rules apply unchanged, by calling
  `schema-refactor`'s own pipeline function directly.

## Outputs

- `schema-crosswalk` MUST always produce both the crosswalk CSV (same shape
  as standalone `schema-map`'s output) and the mapped layer (same shape as
  standalone `schema-refactor`'s output) in a single run.
- `schema-crosswalk` performs no topology check at all; neither underlying
  stage touches geometry.

## Configuration

- The target schema override (name/code templates) MUST behave identically
  to standalone `schema-map`'s override.
- To iterate on a `schema-crosswalk`-generated crosswalk (hand-edit it, then
  re-apply), use standalone `schema-refactor` on the downloaded crosswalk
  CSV; re-running `schema-crosswalk` always maps fresh, discarding any hand
  edits.
