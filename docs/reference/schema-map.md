# schema-map

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-map` shares with other tools.

## Inputs

- `schema-map` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- `schema-map` MUST process exactly one input file per run.
- `schema-map` MUST NOT use column names or column-value vocabulary as a
  matching signal anywhere in its algorithm. Every decision MUST derive
  only from cardinality, containment, textual embedding, or bijection.

## Candidate columns

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
  = 0`) from level-group formation and chain building, since two all-null
  columns are vacuously bijective with no real evidence. It MUST still
  remain eligible for bracketing and MUST still appear in the output.

## Level-group formation

- `schema-map` MUST group remaining candidate columns by identical
  `COUNT(DISTINCT)`, then cluster columns within each same-count group
  pairwise: two columns join one cluster only if bijective with each
  other (containment holds in both directions, see below). A column
  sharing a count with a cluster but not bijective with any member of it
  MUST form its own singleton group, not be dropped and not break the
  cluster apart.
- Containment (`_containment_holds(coarser, finer)`) MUST hold when every
  `finer` value maps to at most one `coarser` value, tolerating exactly
  one violating `finer` value (a single reused sentinel, e.g. a
  missing-value placeholder string). Two or more distinct violating
  values MUST fail containment.

## Chain building

- `schema-map` MUST test every ordered pair of level-groups (by ascending
  `COUNT(DISTINCT)`) for a coarser-to-finer edge, not just
  cardinality-adjacent pairs.
- An edge MUST be valid only when containment holds in both directions
  between every column pair across the two groups, AND at least one of:
  the coarser group's count is exactly 1 (a true constant needs no
  embedding justification); OR at least one finer-group column embeds
  (textually contains, tolerating one sentinel) at least one coarser-group
  column; OR no group pair anywhere in the file has any embedding evidence
  at all (a file that nests purely by independent numbering or by name,
  with no compound/embedded codes anywhere).
- `schema-map` MUST resolve the hierarchy as the longest path through this
  edge DAG (dynamic programming: `best_len[finer] = max(best_len[coarser]
  + 1)` over valid edges), breaking ties by, in order: longer path length,
  larger companion-group size, then higher (finer) `COUNT(DISTINCT)`.

## Role assignment

- `schema-map` MUST skip a chain level entirely (no role, no target
  column) when its group's `COUNT(DISTINCT) = 1`. This exclusion MUST be
  value-based (count equals 1), never based on the level's position in
  the chain.
- For every other chain level, `schema-map` MUST assign each column in the
  level's group a role independently, from that column's own evidence
  only, never deferring to a sibling column's result: `code` if the
  column embeds any column in the parent level, OR if a majority
  (strictly more than 50%) of its non-null values, cast to text, contain
  a digit; `name` otherwise.
- `schema-map` MUST render each level's resolved code/name columns via the
  target schema's `code_field`/`name_field` templates (see Configuration),
  substituting the level's 0-based chain rank for `{n}`. The first column
  in a role at a level (by original source-column order) MUST get the
  bare rendered name; each subsequent column in the same role at the same
  level MUST get the rendered name suffixed `1`, `2`, ...
- `unique_count` for a level-assigned column MUST be `COUNT(DISTINCT
  (parent_level_code_column, this_column))` when the level has a resolved
  parent, or the column's own `COUNT(DISTINCT)` when it is the coarsest
  resolved level.

## Bracketing leftover columns

- A candidate column not absorbed into the chain MUST be bracketed to the
  sole chain level `k` where `chain_level[k-1].count < column.count <=
  chain_level[k].count` (the position below the coarsest level counts as
  0). A column whose count falls in no such range MUST fall through to
  the unmatched fallback.
- `schema-map` MUST skip bracketing entirely for a level whose own chain
  count is 1.
- Within a bracket level, a candidate is a winner when
  `_containment_holds(coarser=candidate, finer=level_code_column)` holds
  (the level's code column is a proper, not necessarily bijective,
  function of the candidate).
- If the level already has a resolved `name` role, every winner MUST get
  `note = "supplemental, superset of level {k}"` and an empty
  `target_column`. If the level has no resolved `name` role yet, winners
  MUST resolve into the `name` role using the same numbered-target scheme
  as chain role assignment.
- A candidate that fails the winner check MUST get `note = "ambiguous,
  level {k}"` and an empty `target_column`.

## Fallback

- Any column still unresolved after chain and bracket resolution MUST get
  an empty `note` and an empty `target_column`. `schema-map` MUST NOT
  guess a target for an unmatched column.

## Outputs

- `schema-map` MUST produce a crosswalk with columns `source_column,
  target_column, unique_count, note`, downloadable as CSV.
- Rows MUST sort finest-resolved-level first (i.e. chain rank descending);
  within a level, a `name`-role row MUST sort before a `code`-role row;
  unresolved rows (no level) MUST sort last, in original source-column
  order. Within a level and role, and among unresolved rows, ties MUST
  break by original source-column order.

## Configuration

- `schema-map` MUST default to the bundled generic target schema
  (`name_field = "adm{n}_name"`, `code_field = "adm{n}_code"`).
- `schema-map` MAY accept a user-supplied override for `name_field`/
  `code_field`. Both templates MUST contain a `{n}` placeholder; an
  override missing either MUST be rejected before running.
