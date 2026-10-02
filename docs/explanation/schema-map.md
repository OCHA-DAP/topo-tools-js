# Schema Map

Schema Map (at `/schema-map`) infers a crosswalk from a layer's structure,
lets the user edit it in a table, and applies it. It is one page over two
pipeline steps that mirror topo-tools-py's separate commands: inference
(Inference, below) and `schema-refactor`, which renames and drops
(`docs/explanation/schema-refactor.md`).

## Why one tool

On the command line, the human review between inference and
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
2. **Infer** (`runSchemaMap`) on load and on template edits,
   writing `sm_crosswalk`.
3. **Edit** (`App.svelte`): each row's checkbox and target name start from
   the imported crosswalk if one is loaded and matches the layer, else the
   inferred one, and user edits override either. Row order follows the same
   precedence, and is the output column order, so a layout travels in the
   CSV. "Sort to default order" re-applies `canonicalOrder` to the current
   targets, which also slots a column renamed into a level (`water` to
   `adm2_type`) between that level's name and code. `rowIssues` flags a checked
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

## Inference

`schema-map` structurally infers which columns in a polygon layer's
attribute table form a nested admin hierarchy (e.g. country -> province ->
district), and proposes a crosswalk to a target schema for a human to
review and edit. It never matches column names or value vocabulary against
a known list: levels come from cardinality, containment, textual embedding,
and correspondence, and column names are only compared with each other to
settle a tie. Ported from topo-tools-py's `schema-map`
(`docs/dev/explanation/1-schema/schema_map.md` there) at its 0.12 algorithm;
this app carries over the same algorithm, adapted to many small targeted DuckDB queries orchestrated by
TypeScript control flow instead of Python loops around `conn.execute()`
calls, following this app's own "scale with columns, not rows" precedent
already used by `package-polygons`.

Column-name/vocabulary matching was topo-tools-py's original design
(deleted in its ADR-0054, after failing on real French-vocabulary Malagasy
and GRID3 DRC data) and was never ported here; this app has no name-based
fallback to fall back to.

### Pipeline

1. **Load** (`$lib/db/loader`, shared) - the same loader every tool uses;
   `schema-map` reads `layer_attr`'s schema directly, with no group-by or
   column-picker step of its own.
2. **Candidate columns** (`pipeline/inference.ts`'s `candidateColumns`) -
   `DESCRIBE layer_attr`, minus `fid`/`geom`, minus a noise column
   (`pipeline/constants.ts`'s `isNoiseColumn`, matching topo-tools-py's
   GDAL-collision-suffix-aware check exactly).
3. **Cardinality** (`pipeline/queries.ts`'s `distinctCounts`) - one query,
   `COUNT(DISTINCT)` for every candidate column at once. An all-null,
   date/time or fractional column is filtered out of chain candidacy.
4. **Level groups** (`pipeline/inference.ts`'s `clusterByBijection`) -
   union-find clusters fully-populated columns of equal count that are
   bijective, then groups sparse columns by joint-row correspondence and
   attaches them to a dense cluster where unambiguous.
5. **Chain** (`pipeline/inference.ts`'s `buildChain`) - longest-path DP over
   the full containment/embedding DAG between every group pair, not just
   cardinality-adjacent ones, then `vetoUnanchoredGroupings` drops a level
   that alone breaks the chain's naming.
6. **Role assignment** (`pipeline/inference.ts`'s `assignChainRoles`) - per
   level, per column, independently: `code` if it embeds a resolved parent
   column or looks code-shaped, `name` otherwise, with `breakShapeTie`
   naming a nameless level's codes by the template text. Levels are
   numbered from the finest level when given, else a varying coarsest
   level is 1.
7. **Bracketing** (`pipeline/inference.ts`'s `bracketOtherColumns`/
   `bracketLevel`) - leftover columns slotted into the nearest chain level
   by cardinality range, resolved to `name`, `supplemental`, or
   `ambiguous`.
8. **Sort + output** (`pipeline/inference.ts`'s final sort,
   `pipeline/outputs.ts`'s `writeCrosswalkTable`) - finest-level-first
   ordering, written to a `sm_crosswalk` DuckDB table for CSV export via
   `$lib/db/export.ts`.

### Why the edge-validity rule has three branches

A chain edge (coarser group -> finer group) needs containment to hold, plus
one of three justifications: the coarser group is a true constant (nothing
to embed against); at least one column pair embeds; or no pair anywhere in
the file embeds at all. All three come from real country files in
topo-tools-py's history (its ADR-0064, ADR-0066, ADR-0070): a constant
admin0 needs no embedding evidence to anchor a hierarchy under it; a
country whose admin1 is numbered independently of its admin0 (DRC's ISO2
admin1 vs ISO3 admin0) still needs to chain via containment alone; and a
file that nests purely through independently-numbered codes or through
names, with no compound code anywhere (DRC's GRID3 health-facility layers),
needs the same containment-only fallback file-wide, not edge-by-edge,
since two unrelated attributes can satisfy containment by chance in a small
file and a single embedding-evidence check elsewhere in the same file is
enough to rule that risk out.

### Why role assignment never defers to a sibling

An earlier version defaulted a non-embedding column to `name` whenever
some other column in its group embedded the parent. This broke twice on
real data (topo-tools-py's ADR-0067): a genuine second numeric code column
with no compound structure got mislabeled `name` purely because a sibling
embedded; and a coincidentally-row-unique `area_sqkm` column, sharing a
level's cardinality by chance, claimed the `name` role and displaced the
real name column into a lower-confidence bracket result. Testing this
port's `cod/adm2` fixture (see Verification below) reproduces exactly this
scenario: `area_sqkm` independently resolves `code` (digit-shaped values),
leaving the real `adm2_name`/`adm2_pcode` pair to resolve cleanly.

### Why a losing bracket candidate is "supplemental," not always "ambiguous"

A bracketed candidate that passes a one-way function check against a
level's code column, but isn't itself bijective with it, cannot be a
same-level rival: by pigeonhole, a function between two equal-cardinality
finite sets is automatically one-to-one, so failing bijection means the
candidate has strictly different (coarser) cardinality. It's a genuine,
independently-defined coarser grouping, not noise, hence a distinct
`supplemental` label from `ambiguous` (topo-tools-py's ADR-0065). A
candidate failing the function check in both directions has no defensible
relationship to report at all, and stays `ambiguous`.

### Why a root-prefix restriction protects the chain

Only an unbroken, fully-populated run of single-value groups starting at
the coarsest position (`orderGroupsByContainment`'s coarsest-first,
containment-based ordering, not raw `COUNT(DISTINCT)`) is trusted as a free
chain root needing no embedding evidence of its own. A single-value group
anywhere else in the ordering, most often a sparse audit-style column that
happens to have one non-null value, cannot silently justify an
embedding-free chain link (topo-tools-py's ADR-0100).

### Why the root's embedding-free freebie sometimes needs spatial corroboration

Once a `geom` column is loaded, an ungrounded finer group extending
straight off a constant root is corroborated by checking that its own
values partition the file's centroids into spatially coherent clusters
(R² >= 0.7 against total centroid variance, waived under 10 evaluated
rows). The same corroboration backs `embeds`'s existing one-sentinel
tolerance: a single string-containment violation is excused only if the
child column is itself spatially coherent. Two real false chains motivated
this (Colombia's/Ecuador's/Tunisia's/Greece's audit columns outranking the
real hierarchy); a blanket version applied everywhere regressed
correctly-chaining Belgium/Costa Rica data, so it stays scoped to these two
call sites.

### Temporal and fractional columns are excluded by type, not name

A `DATE`/`TIME`/`TIMESTAMP`/`INTERVAL` column is excluded from chain
candidacy before cardinality sees it (`$lib/db/columnTypes.ts`'s
`isTemporalDuckdbType`), and never wins the code/name tiebreak via
`looksCodeShaped`'s digit-majority heuristic: a formatted date is
digit-heavy but carries no hierarchy meaning. A float or decimal column
holding a non-whole value is a measurement (area, a coordinate) and is
excluded the same way, and a floating column never serves as embedding
evidence, since a fraction's digits contain short codes by chance. These
are type checks, never name checks.

### Column resolution is one shared function

`pipeline/inference.ts`'s `resolveColumns` is the whole structural
resolution pipeline (candidate columns through chain-building through
bracketing) minus the final crosswalk sort; `inferSchemaMap` is a thin
wrapper around it. `schema-fill`'s auto-detect path and the `package-*`
tools' level-detection engine both consume `resolveColumns` directly, so no
tool's structural understanding of a file can drift from schema-map's own.

### Why sparse columns cluster on joint rows

COD-AB files often carry alternate-language name columns that are only
populated for part of the country. Strict bijection fails on them (a NULL
maps to every value), so they used to fall out of their level and get
bracketed as `ambiguous`. A sparse column is instead compared with each
cluster only where both are populated, and needs at least 10 joint values,
or every value of both sides, so two small coincidentally aligned columns
are not merged (topo-tools-py's ADR-0114). A column matching
several clusters joins none, since the data cannot say which level it
belongs to.

### Why strong, bridged and vetoed levels

Three edge cases from topo-tools-py's corpus extend the chain rules. A
finer level whose codes are surrogate IDs (nothing embeds) still chains
under a parent it maps perfectly into, when it is nearly row-unique and
the chain above it is already grounded by an embedding (a "strong" edge).
A name-only middle level (an adm2 with names but no codes between adm1 and
adm3) can chain when its naming digit sits between its neighbours' and the
skip across it embeds (a "bridged" edge). And a level linked to its child
only by bare containment is dropped as a supplemental grouping when the
chain's columns share more naming text without it: data alone can't tell
Nigeria's senatorial districts over LGAs from a real level
(topo-tools-py's ADR-0113). Names may veto a level this way, never add
one, and are only compared with each other, never against a vocabulary.

### Level numbering

A file usually holds one country, with its admin0 either constant or
absent. A constant root folds away and the next level is 1; without one,
the coarsest varying level is still numbered 1, assuming one country above
the file. A file that lacks its coarser levels (an admin3-only extract) or
spans several countries numbers wrongly under that assumption, so the
finest level can be set explicitly and the rest are numbered upward from
it by nesting depth.

### Level detection for other tools

`levelColumns.ts` groups the resolved rows by level for `schema-fill`,
`schema-join`, the code tools and the `package-*` tools. It diffs naming
anchors on the columns sharing the most text across levels, rather than
each level's highest-cardinality column, because a level's alternate-name
column can outnumber its code and break the shared prefix. It also adds a
name-only leaf level when a finer name family (`adm4_name` under coded
`adm3_*`) is unique within each parent: structural inference can't see it,
since a level with no code has nothing to embed.

### Query shape

Every relational check (`COUNT(DISTINCT)`, containment, embedding,
bijection) is its own small, targeted DuckDB query in `pipeline/queries.ts`,
run for one column pair at a time and orchestrated by TypeScript loops in
`pipeline/inference.ts`. Candidate columns run to single digits or low
dozens per file, so the total query count (roughly quadratic in column
count for chain-building) stays cheap; this mirrors topo-tools-py's own
structure of Python loops around individual `conn.execute()` calls, and
this app's own `package-polygons` precedent of a query shape that scales with
column count, not row count.

### Row-order determinism

This app runs DuckDB WASM with `preserve_insertion_order = false` (see
`docs/reference/shared.md`), so a plain `SELECT * FROM sm_crosswalk` is not
guaranteed to return rows in insertion order. `writeCrosswalkTable` stores
an explicit `column_order` column, and `$lib/db/export.ts`'s `schema_map`
source config selects with `ORDER BY column_order`, mirroring
topo-tools-py's own explicit `ORDER BY column_order` at CSV-export time.

### Verification

Cross-checked against topo-tools-py's `schema-map --map-only` on eleven
portolan `original` files (AFG, AGO, ARM, BDI, BEN, BFA, BGD, ETH, GNB, LAO,
MEX, ZMB, admin1 to admin4) and five derived variants (anonymised column
names, custom names, a name-only middle level, a partly populated alternate
name, and an explicit finest level), with identical crosswalks, plus the
too-shallow error. `detectLevelColumnsOrSingle` matched py's
`detect_level_columns_or_single` on twelve of these, including two with a
name-only leaf level.
