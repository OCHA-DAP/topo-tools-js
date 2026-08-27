# Dissolve

`dissolve` aggregates a fine polygon layer into a coarser one by grouping on
one or more attribute columns picked in the UI (typically ancestor
admin-level code columns, e.g. `adm2_pcode` to collapse an admin3 layer into
admin2), unioning each group's geometry into a single feature. Ported from
topo-tools-py's `dissolve` (`docs/explanation/dissolve.md` there); this app
carries over the same algorithm and the same "no keep/exclude override"
scope decision (see topo-tools-py's ADR-0050), adapted to a browser column
picker instead of a CLI flag.

## Pipeline

1. **Load** (`App.svelte`, via `$lib/db/loader`) - the shared loader, then a
   `DESCRIBE layer_attr` populates the group-by checkbox list.
2. **Dissolve** (`pipeline/index.ts`) - joins `layer_01`/`layer_attr` into a
   working table, then resolves every non-`group_by` column automatically: a
   single combined query checks whether each one is constant within every
   group (`COUNT(DISTINCT col)` per group, collapsed to one summary row via
   `MAX(...)` so the check scales with the number of columns, not the number
   of groups), retaining it (`any_value`) if so and dropping it if not. It
   then runs one `GROUP BY` + `ST_Union_Agg` + `ST_MakeValid` query. A NULL
   value in a `group_by` column forms its own group here, plain SQL
   `GROUP BY` behavior, with no special-casing needed.
3. **Issues** (`pipeline/issues.ts`, via `$lib/db/coverage`'s
   `gapRegionsQuery`) - any interior hole left in the dissolved output wider
   than `SNAP_TOLERANCE` gets a `kind='gap'` row (area, max width, thinness
   ratio), the same gap-only shape `stitch` uses. There are no overlap rows:
   a plain `GROUP BY` dissolve cannot itself produce an overlap.

## Why non-group columns resolve automatically, with no override

Every non-`group_by` column is checked by the tool itself, with no
column-selection UI beyond picking `group_by`: a column that's constant
within every group survives (`any_value`); a column that varies is dropped,
and the run summary names every dropped column so the user can see why. A
pipeline that needs a summed/combined attribute alongside the dissolved
geometry runs that aggregation separately (e.g. a DuckDB `GROUP BY` query
against the same input, joined back on the `group_by` columns) rather than
through `dissolve` itself, which stays scoped to boundary topology, not data
enrichment.

## Column picker

There is no existing precedent in this app for a multi-select over an
arbitrary column set; the closest is Changelog's single-column `<select>`
fed by `detectColumns()`. `dissolve` reuses `detectColumns()` for its `.all`
column list (skipping its code/name guessing, which doesn't apply here) and
renders it as a checkbox list, since more than one column can jointly form
the group key (e.g. `adm2_pcode` + `adm1_pcode`).
