# Schema

`schema` (Schema Crosswalk, at `/schema`) infers a crosswalk from a layer's
structure, lets the user edit it in a table, and applies it. It is one page
over two pipeline steps that mirror topo-tools-py's separate commands:
`schema-map` infers (`docs/explanation/schema-map.md`) and `schema-refactor`
renames and drops (`docs/explanation/schema-refactor.md`).

## Why one tool

On the command line, the human review between `schema-map` and
`schema-refactor` happens in a hand-edited CSV, so they are separate
commands. In the browser the review happens in the table, and a separate
page per step would only send the user out to a spreadsheet. The CSV stays
available as an output and an optional input, for sharing a crosswalk or
re-applying it to another delivery, and it round-trips with topo-tools-py's
`schema-refactor`.

Unmapped columns default to dropped, as in topo-tools-py, so the same CSV
yields the same layer in both. Keep and drop are a checkbox per row, separate
from the target name, so dropping a column never discards the name it would
be renamed to.

## Pipeline

1. **Load** (shared loader) into `layer_01` and `layer_attr`. The geometry
   is serialized to GeoJSON once, for the map, and `sampleValues` reads up to
   three sorted distinct values per column.
2. **Infer** (`schema-map`'s `runSchemaMap`) on load and on template edits,
   writing `sm_crosswalk`.
3. **Edit** (`App.svelte`): each row's checkbox and target name start from
   the imported crosswalk if one is loaded and matches the layer, else the
   inferred one, and user edits override either. `rowIssues` flags a checked
   row with no name, plus `targetIssues`'s duplicate and reserved targets
   (beside `validateTargets` in `schema-refactor/pipeline/validate.ts`, so
   both share one rule set).
4. **Apply** (`applyCrosswalk`): `schema-refactor`'s `runSchemaRefactor`
   writes `sr_result_attr`, then `sm_crosswalk` is rewritten with the
   effective targets so the CSV matches the table. Applying is
   attribute-only SQL, so it reruns on every edit (debounced), on the same
   serial task queue as inference and loading.
5. **Outputs** export from DuckDB: the mapped layer from `layer_01` joined to
   `sr_result_attr` (export source `schema_refactor`), the CSV from
   `sm_crosswalk` (export source `schema_map`).

## Memory

Renaming never touches geometry, so the tool builds no mapped-layer GeoJSON.
The map shows the loaded layer, and a clicked feature's values come from a
point-in-polygon query (`attributesAt` in `$lib/db/layerView.ts`) against
`layer_01` joined to `layer_attr`. At buurt scale (14.8k Dutch
neighbourhoods) this measured 1.25 GB peak JS heap and 0.44 GB after
garbage collection. Building a second, attribute-carrying GeoJSON for the
map measured 2.07 GB and 0.83 GB on the same file.
