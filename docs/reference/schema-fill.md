# schema-fill

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-fill` shares with other tools.

## Inputs

- `schema-fill` MUST load the input via the shared loader (see
  `docs/reference/shared.md`).
- `schema-fill` MUST accept an optional target-schema shape `schema-map`
  accepts (a `nameField`/`codeField` pair, each containing a `{n}`
  placeholder); both MUST be given together or both omitted.
- Given a target schema, `schema-fill` MUST detect every admin level `1..N`
  present via the schema's `codeField` prefix (e.g. `adm`), `N` being the
  deepest level column found, and MUST raise if any level in that range is
  missing its own code column, or if none is found at all. `schema-fill`
  MUST additionally include level 0 in the detected/filled range whenever
  its own code column (e.g. `adm0_code`) is present, without requiring it.
- Given no target schema, `schema-fill` MUST detect the same level set
  structurally instead, via `schema-map`'s level-detection engine, and MUST
  raise if any detected level lacks its own code column, or if none is
  found at all.

## Filling

- For each admin-hierarchy column family sharing a level prefix and suffix
  (matched independently against the schema's own `nameField` prefix and
  `codeField` prefix when a schema is given, e.g. every `adm{n}_code`,
  every `adm{n}_name`, or grouped by shared naming kind across
  structurally-detected levels otherwise), `schema-fill` MUST leave a
  value at level `k` untouched when a row's own depth reaches `k`, even
  when that value is `NULL`. `schema-fill` MUST fill a `NULL` value at
  level `k` only when a row's own depth stops short of `k`, from the
  nearest non-`NULL` shallower level.
- `schema-fill` MUST append one new column, named by the configured depth
  column (default `adm_lvl`), stamping each row with the deepest level
  whose _original_ (pre-fill) code column was non-`NULL`.
- `schema-fill` MUST NOT touch geometry, and MUST NOT drop or rename any
  column other than adding the depth column.

## Outputs

- `schema-fill` performs no topology gate at all; it only fills attribute
  columns and stamps a depth column, never touching geometry.
- `schema-fill` MUST export the filled layer.

## Configuration

- `schema-fill` MUST process exactly one input file per run.
- `schema-fill` MAY accept a depth column name, overriding the `adm_lvl`
  default.
