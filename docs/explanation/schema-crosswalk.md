# Schema Crosswalk

`schema-crosswalk` runs `schema-map` immediately followed by `schema-refactor`
in one call, mirroring this app's `mosaic` (wraps assign-one + clip + stitch)
pattern: the two underlying tools remain available standalone, and this
composite just chains them for a fast first pass, so a user can see mapped
values right away and judge whether the proposed crosswalk is correct,
rather than reading a crosswalk CSV in the abstract. Ported from
topo-tools-py's `schema-crosswalk`
(`docs/explanation/schema_crosswalk.md` there).

## Pipeline

1. **Load** (`$lib/db/loader`, shared) - the layer loads once, into
   `layer_01` and `layer_attr`, exactly as standalone `schema-map` and
   `schema-refactor` each load it.
2. **Map** (`schema-map`'s `runSchemaMap`) - called directly, unmodified,
   against the loaded `layer_attr`; writes the crosswalk to `sm_crosswalk`
   and returns the same `CrosswalkRow[]` standalone `schema-map` returns.
3. **Apply** (`schema-refactor`'s `runSchemaRefactor`) - called directly,
   unmodified, with the crosswalk from step 2 passed as an in-memory array;
   validates it against `layer_attr` and writes `sr_result_attr`.
4. **Outputs** - the crosswalk CSV downloads from `sm_crosswalk` via the
   existing `schema_map` export source, and the mapped layer downloads from
   `layer_01`/`sr_result_attr` via the existing `schema_refactor` export
   source; no new export sources were needed.

## No table namespacing needed

topo-tools-py's own implementation needs a `{name}_apply` table-namespacing
workaround: its `schema_map` and `schema_refactor` core stages both
hardcode `{name}_02` for different data (the crosswalk proposal vs. the
renamed table), and its CLI runs the two tools as genuinely separate
invocations sharing one `name`. This port has neither problem: `runSchemaMap`
and `runSchemaRefactor` are in-process TypeScript functions with their own
fixed table names (`sm_crosswalk` vs. `sr_result_attr`), called back to back
on one connection, so nothing collides and nothing needs namespacing.

`schema-refactor`'s pipeline function already took `CrosswalkRow[]` as a
plain in-memory argument, with CSV parsing (`loadCrosswalkCsv`/
`parseCrosswalk`) factored out as separate, `App.svelte`-facing utilities.
`schema-crosswalk` calls the pipeline function directly and skips the CSV
round-trip entirely.

## Not modeled

`schema-crosswalk` cannot resume from a hand-edited crosswalk; it always maps
fresh. The iteration workflow (download the crosswalk CSV, hand-edit it,
re-apply) goes through standalone `schema-refactor`, not `schema-crosswalk`,
by design (see `docs/reference/schema-crosswalk.md`).
