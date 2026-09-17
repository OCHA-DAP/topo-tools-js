# code-update

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `code-update` shares with other
tools, including the "Hierarchical code format and retention" section it
shares with `code-refactor`.

## Inputs

- `code-update` MUST accept exactly two inputs, OLD (already coded) and
  NEW (uncoded candidate), each loaded via the shared loader and coverage-
  cleaned independently (`gatedCoverageClean` on each side's own
  finest-level geometry table).

## Level resolution and format detection

- `code-update` MUST resolve OLD's and NEW's own per-level code/name
  columns independently, each via the same explicit-pair-or-structural-
  fallback contract `code-refactor` uses: a name/code field template pair
  for OLD, a name/code field template pair for NEW, or, when a side omits
  both, structural auto-detection (`schema-map`'s
  `detectLevelColumnsOrSingle`).
- `code-update` MUST raise if either side resolves a level with no code
  column at all, rather than silently skipping that level.
- `code-update` MUST raise if OLD's and NEW's resolved level counts
  differ, before any dissolve/classify stage runs.
- `code-update` MUST detect `rootCode`/`delimiter`/`minWidth` from OLD's
  own resolved finest-level code column whenever any of the three is
  omitted; each field independently falls back to the detected value only
  when that field itself is `null`, an explicitly given field is never
  overridden by detection.

## Dissolve

- `code-update` MUST dissolve OLD and NEW independently at every resolved
  level, always from that side's own original finest-level input table
  (never chained from a coarser level's own dissolve output): OLD grouped
  by its own already-real code column, NEW grouped by its own resolved
  (structural or explicit) raw column.

## Classify

- `code-update` MUST classify every level by reusing `change`'s own
  overlap and classify stage functions directly against that level's two
  dissolved tables, producing every `relationship_class` `change` defines:
  `unchanged`, `renamed`, `modified`, `relocated`, `split`, `merge`,
  `complex`, `created`, `removed`.
- `tauMatch`, `tauSame`, `linkByCode`, `linkByName`, and `linkMode` MUST be
  plain passthrough to `change`'s own classification engine, same names
  and defaults (`tauMatch=0.8`, `tauSame=0.98`, `linkByCode=false`,
  `linkByName=false`, `linkMode="either"`).
- The identity-linking code/name columns MUST be that level's own resolved
  code/name columns on each side; this app does not expose a separate
  override distinct from the level's own resolution.

## Reparent

- For every level finer than the coarsest, `code-update` MUST re-derive
  each NEW unit's true current parent spatially against the immediately-
  coarser level's NEW, already-dissolved units (`assignBestOverlap`,
  per-child best overlap, shared with `match`); it MUST NOT trust a stale
  embedded parent column.

## Assign (retention policy)

Applied per level, ascending, using the level's own already-re-derived
parent codes:

| `relationship_class` | outcome |
|---|---|
| `unchanged`, `renamed` | code retained: `rewriteChildCode()` reattaches the OLD code's own tail onto the unit's (possibly new) parent prefix |
| `modified`, `relocated` | new code assigned under the re-derived parent; `predecessor_code` is the one linked OLD code |
| `created` | new code assigned; `predecessor_code` is `NULL` |
| `split` (1 OLD to N NEW) | each NEW unit gets its own new code; all share one `predecessor_code`, the one OLD code |
| `merge` (N OLD to 1 NEW) | the one NEW unit gets one new code; `predecessor_code` is `NULL` on that geometry row |
| `complex` (N OLD to M NEW) | each NEW unit gets its own new code, one shared next-available scope per level; `predecessor_code` is `NULL` on every geometry row |
| `removed` | no NEW-side output row; the OLD code is excluded from output and from this run's own next-available computation |

- A parent's next available integer MUST be derived only from codes
  currently retained (`unchanged`/`renamed`) this same run, at this same
  level, never a persisted registry. A code retired this run MAY be
  immediately reused by an unrelated new/split/merge/created unit at the
  same level in the same run.
- `match_method` MUST be that one pair's own `change`-assigned value
  (`"spatial"` or `"identity"`) for a cluster spanning exactly one old/new
  pair; for a cluster spanning multiple linked pairs (`merge`, `complex`,
  or a `split`'s per-child links), every linked pair's own `match_method`
  MUST be collapsed into one value, joined with `"+"` when genuinely
  mixed.
- A `'new'`-outcome row's `code_outcome` MUST be overwritten to
  `'overflow'` (reusing `code-refactor`'s own `10 ** minWidth - 1`
  capacity rule) when its parent's total retained-plus-new child count at
  that level exceeds capacity; `reason` MUST be overwritten to state the
  overflow. `'retained'` rows are never flagged, even when technically
  over capacity.

## Outputs

- `code-update` MUST write each level's new code into the column OLD's own
  resolution named at that level, in place on the NEW-side finest
  attribute table. NEW's own raw column at that level, if differently
  named, MUST be left untouched as an ordinary passthrough attribute.
- `code-update` MUST add a `predecessor_code` column, populated only for
  the finest level's own rows.
- `code-update` MUST always write a changelog, even when it would be
  empty, no geometry column: `level`, `old_code`, `old_name`, `new_code`,
  `new_name`, `relationship_class`, `cluster_id`, `match_method`,
  `code_outcome` (`retained`/`new`/`retired`/`overflow`), `reason`. A
  `merge` gives N retired rows plus 1 new row; a `complex` cluster gives
  one row per actually-linked old/new pair, never a full N×M
  cross-product; a `removed` code gives one row with `new_code=NULL`; a
  `created` code gives one row with `old_code=NULL`.
- `code-update` performs no topology hard gate of its own beyond the
  shared coverage-clean gate applied to each side's input.

## Configuration

- `code-update` MUST process exactly one OLD/NEW file pair per run.
- `linkMode` MUST be `"either"` or `"both"`.
