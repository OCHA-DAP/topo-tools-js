# schema-map

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-map` shares with other tools.

Schema Map is the tool at `/schema-map`. It infers a crosswalk (Inference,
below), lets the user edit it, and applies it with `schema-refactor`
(`docs/reference/schema-refactor.md`).

## Inputs

- Schema Map MUST take exactly one polygon layer (query parameter `url`).
- Schema Map MAY import a crosswalk CSV (query parameter `crosswalk`),
  parsed by `schema-refactor`'s crosswalk rules. Its targets MUST replace
  the inferred ones as the starting point for editing. Its input, the
  target schema templates and the finest level MUST sit under Advanced
  options, closed by default.
- An imported crosswalk whose `source_column` set does not match the layer MUST
  be reported with `schema-refactor`'s column-mismatch error, and the
  inferred crosswalk MUST be used instead.

## Mapping

- Schema Map MUST infer the crosswalk with the rules under Inference.
- Editing the name or code template, or the finest level, MUST re-run
  inference automatically, under Inference's template and numbering rules.
- The finest level (query parameter `level`) MUST be empty (auto) or a
  non-negative whole number; any other value MUST be flagged and MUST NOT
  run inference.
- A column with no inferred target MUST default to dropped, matching
  Inference's empty `target_column`.

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

## Ordering

- Table row order MUST be the output column order, and the crosswalk CSV
  MUST be written in it.
- Rows MUST start in the imported crosswalk's row order if one is loaded and
  matches the layer, else in Inference's order.
- A row MUST be movable by dragging its grip, and one place at a time with
  Alt+↑/↓ on the focused grip.
- "Sort to default order" MUST order kept rows by the templates applied to
  their current targets (Inference's level order: deepest first, names,
  other same-level columns, codes), then dropped rows in their current order.
- Row order MUST persist across re-inference until "Reset all edits".

## Applying and outputs

- Every valid crosswalk state MUST be applied automatically with
  `schema-refactor`'s pipeline, unchanged.
- Schema Map MUST offer the mapped layer (`schema-refactor`'s output, suffix
  `_mapped`) and the crosswalk CSV (Inference's output shape, suffix
  `_crosswalk`), both reflecting the current edits.
- The map MUST draw the loaded geometry once. Applying a crosswalk MUST NOT
  serialize geometry.
- The map MUST fill each unit by its parent unit, keyed on the source
  columns mapped to codes above the finest level, in Package's palette,
  and in one color when no such column is mapped. Edits MUST recolor
  without redrawing the geometry.
- Clicking a feature MUST show its source value on every row. With no
  feature selected, each row MUST show up to three sorted distinct sample
  values of its column.
- Schema Map performs no topology check; nothing it runs touches geometry.

## Inference

### Inputs

- `schema-map` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- `schema-map` MUST process exactly one input file per run.
- `schema-map` MUST NOT match column names or column-value vocabulary
  against any known list. Levels MUST derive from cardinality,
  containment, textual embedding, or correspondence. Column names MAY only
  be compared with each other, to bridge or drop a chain level (Chain
  building) and to break a role tie (Role assignment).

### Candidate columns

- `schema-map` MUST exclude `fid` and `geom` (this app's own internal
  columns) from candidacy.
- `schema-map` MUST exclude a noise column: case-insensitive exact match
  against `objectid, globalid, fid, shape_leng, shape_length,
shape__length, shape_area, shape__area, ogc_fid, ogc_fid_orig,
fid_orig`; OR the column name with a trailing `_\d+` GDAL
  collision suffix stripped matches that list; OR, when the full column
  name is exactly 10 characters (the DBF field-name limit), the
  suffix-stripped name is a case-insensitive prefix of an entry in that
  list.
- `schema-map` MUST exclude an all-null candidate column (`COUNT(DISTINCT)
= 0`) and a date/time column from level-group formation and chain
  building. They MUST still remain eligible for bracketing and MUST still
  appear in the output.
- A `FLOAT`, `DOUBLE` or `DECIMAL` column holding any non-whole value MUST
  be excluded from level-group formation, chain building and bracketing,
  and MUST still appear in the output.

### Level-group formation

- Containment (`containmentHolds(coarser, finer)`) MUST hold when every
  non-null `finer` value maps to exactly one non-null `coarser` value,
  tolerating one violating `finer` value once there are more than 2
  `finer` groups. Two or more violating values MUST fail containment.
- Fully-populated columns MUST be clustered pairwise: two columns join one
  cluster only if they share a `COUNT(DISTINCT)` and are both constant, or
  are bijective (containment both ways, on a table of at least 2 rows). A
  column sharing a count with a cluster but not bijective with any member
  MUST form its own group, not break the cluster apart.
- A column with any NULL MUST cluster only by 1:1 correspondence on the
  rows where both columns are populated (each side takes one value per
  value of the other, tolerating one duplicated pair, never a value
  spanning more than 2), over at least 10 joint values, or over every
  value of both columns and at least 2. Sparse columns populated on
  identical rows MUST group first. A sparse group that nests both ways
  with exactly one non-constant dense cluster MUST join it. A lone sparse
  column MUST join the one dense cluster it corresponds with, else the one
  sparse cluster, and MUST join none when it matches several.
- Groups MUST be ordered coarsest-first by pairwise containment, ties by
  `COUNT(DISTINCT)`, then column list.

### Chain building

- `schema-map` MUST test every ordered pair of level-groups for a
  coarser-to-finer edge, not just cardinality-adjacent pairs.
- An edge MUST require containment from every coarser-group column to
  every finer-group column, AND at least one of:
  - the coarser group is in the root prefix (an unbroken run of
    fully-populated constant groups from the coarsest), and, with geometry
    loaded and no embedding, some finer-group column is spatially coherent
    (its groups explain at least 70% of centroid variance, waived under 10
    rows);
  - some non-floating finer-group column embeds (textually contains, on
    rows where the parent value is non-blank, tolerating one sentinel
    value) some non-floating coarser-group column;
  - the edge is strong (every non-floating coarser column maps perfectly,
    over at least 10 groups, from some non-floating finer column whose
    distinct count is at least 90% of the row count) and the coarser group's
    own best chain already contains an embedded edge;
  - no group pair anywhere in the file embeds;
  - the edge brackets a group whose naming digit (the one digit run all its
    columns agree on) sits strictly between its coarser and finer
    neighbours' digits, where the direct coarser-to-finer edge embeds.
- A constant group outside the root prefix MUST NOT extend a chain.
- `schema-map` MUST resolve the hierarchy as the longest path through this
  edge DAG. Equal-length paths into a group MUST prefer an embedded edge,
  then a code-shaped coarser group. The chain's end MUST be the longest
  path, then the larger group, then the higher `COUNT(DISTINCT)`.
- A chain level whose edge to its child is unembedded and that is not in
  the root prefix MUST be dropped from the chain when the chain without it
  shares strictly more naming text (common prefix plus suffix, one column
  per level, middles distinct) than both the full chain and the chain
  without its child, and its parent contains the child. Every column of a
  dropped level MUST get `note = "supplemental, superset of level {k}"`,
  `k` being its child's level, and an empty `target_column`.
- A chain of one level with fewer than 2 columns MUST be discarded.

### Level numbering

- With the finest level given, the finest chain level MUST be numbered with
  it and each coarser one by nesting depth from it, and inference MUST
  fail with `level={n} is too shallow: found {k} nested levels, so the
coarsest would be {m}` if any resolved level would be below 0.
- Otherwise a coarsest chain level with more than one value MUST be
  numbered 1, and every other chain numbered from 0.

### Role assignment

- A constant coarsest chain level MUST be skipped (no role, no target
  column) when its first column is fully populated and the chain has no
  other level, or the next level's columns are all fully populated.
- For every other chain level, `schema-map` MUST assign each column in the
  level's group a role independently, from that column's own evidence
  only, never deferring to a sibling column's result: `code` if the
  column embeds any column in the parent level, OR if a majority
  (strictly more than 50%) of its non-null values, cast to text, contain
  a digit (never for a date/time column); `name` otherwise.
- When a level has no `name` column and 2 or more `code` columns that do
  not embed the parent, those containing a literal part of the name
  template absent from the code template, and no such part of the code
  template, MUST become `name`, unless that would leave no shape-only
  code.
- `schema-map` MUST render each level's resolved code/name columns via the
  target schema's `code_field`/`name_field` templates (see Configuration),
  substituting the level's number for `{n}`. Within a role at a level, a
  column embedding its parent MUST rank first, then source-column order.
  The first gets the bare rendered name, each next one a numbered sibling
  (`adm2_name1`, or `adm2_1` after a trailing digit).
- `unique_count` for a level-assigned column MUST be `COUNT(DISTINCT
(parent_level_code_column, this_column))` when the level has a resolved
  parent, or the column's own `COUNT(DISTINCT)` when it is the coarsest
  resolved level.

### Bracketing leftover columns

- A candidate column not absorbed into the chain or a dropped level MUST be
  bracketed to the sole chain level `k` where `chain_level[k-1].count <
column.count <= chain_level[k].count` (the position below the coarsest
  level counts as 0). A column whose count falls in no such range MUST
  fall through to the unmatched fallback.
- `schema-map` MUST skip bracketing entirely for a level whose own chain
  count is 1.
- Within a bracket level, a candidate is a winner when
  `containmentHolds(coarser=candidate, finer=level_code_column)` holds.
- A winner MUST get `note = "supplemental, superset of level {k}"` and an
  empty `target_column` when the level already has a resolved `name` role
  and the winner's collapse ratio (`1 - COUNT(DISTINCT candidate) /
level_count`) exceeds 0.30. Every other winner MUST resolve into the
  `name` role using the same numbered-target scheme as chain role
  assignment, after the level's existing names.
- A candidate that fails the winner check MUST get `note = "ambiguous,
level {k}"` and an empty `target_column`.

### Fallback

- Any column still unresolved after chain and bracket resolution MUST get
  an empty `note` and an empty `target_column`. `schema-map` MUST NOT
  guess a target for an unmatched column.

### Level detection

`detectLevelColumns`, used by `schema-fill`, `schema-join`, the code tools
and the `package-*` tools, groups the default-schema resolution by level.

- Each level's code column MUST be its resolved member with the highest
  `unique_count`.
- Naming anchors MUST be diffed on one column per level, picked to share
  the most common prefix plus suffix text, falling back to the code
  columns. A level's anchor is what remains of its column once that
  shared prefix and suffix are removed.
- Levels MUST be renumbered to their anchors' digits when every level has
  one and they strictly increase, else keep their structural numbers.
- An unassigned column carrying a level's anchor, and taking at most one
  non-null value per value of the level's code column, MUST join that
  level.
- A name-only level MUST be added one past the deepest level when columns
  carrying the next anchor digit in an existing column family are unique
  per value of the deepest level's code column (tolerating one repeat
  past 2 rows). It MUST have no code (`hasCode = false`).
- `supplementalColumns` MUST list every column whose note starts with
  `supplemental`.
- `verifyFunctionalCluster` MUST throw when a cluster member takes more
  than one non-null value per value of the canonical column, or, given a
  parent column, when the member's `(parent, member)` pairs (on rows where
  the member is non-null) collapse the `(parent, canonical)` pairs by more
  than 0.30.

### Outputs

- `schema-map` MUST produce a crosswalk with columns `source_column,
target_column, unique_count, note`, downloadable as CSV.
- Rows MUST sort finest-resolved-level first (i.e. level descending);
  within a level, a `name`-role row MUST sort before a `code`-role row;
  unresolved rows (no level) MUST sort last, in original source-column
  order. Within a level and role, and among unresolved rows, ties MUST
  break by original source-column order.

### Configuration

- `schema-map` MUST default to the bundled generic target schema
  (`name_field = "adm{n}_name"`, `code_field = "adm{n}_code"`).
- `schema-map` MAY accept a user-supplied override for `name_field`/
  `code_field`. Both templates MUST contain a `{n}` placeholder; an
  override missing either MUST be rejected before running.
- The templates MUST only render target names and break the shape tie
  under Role assignment; they MUST NOT affect level structure.
