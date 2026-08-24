# Schema Map

`schema-map` structurally infers which columns in a polygon layer's
attribute table form a nested admin hierarchy (e.g. country -> province ->
district), and proposes a crosswalk to a target schema for a human to
review and edit. It never inspects column names or value vocabulary: every
decision comes from cardinality, containment, textual embedding, and
bijection alone. Ported from topo-tools-py's `schema-map`
(`docs/explanation/schema_map.md` there); this app carries over the same
algorithm, adapted to many small targeted DuckDB queries orchestrated by
TypeScript control flow instead of Python loops around `conn.execute()`
calls, following this app's own "scale with columns, not rows" precedent
already used by `dissolve`.

Column-name/vocabulary matching was topo-tools-py's original design
(deleted in its ADR-0054, after failing on real French-vocabulary Malagasy
and GRID3 DRC data) and was never ported here; this app has no name-based
fallback to fall back to.

## Pipeline

1. **Load** (`$lib/db/loader`, shared) - the same loader every tool uses;
   `schema-map` reads `layer_attr`'s schema directly, with no group-by or
   column-picker step of its own.
2. **Candidate columns** (`pipeline/inference.ts`'s `candidateColumns`) -
   `DESCRIBE layer_attr`, minus `fid`/`geom`, minus a noise column
   (`pipeline/constants.ts`'s `isNoiseColumn`, matching topo-tools-py's
   GDAL-collision-suffix-aware check exactly).
3. **Cardinality** (`pipeline/queries.ts`'s `distinctCounts`) - one query,
   `COUNT(DISTINCT)` for every candidate column at once. An all-null
   column is filtered out of chain candidacy but kept for bracketing.
4. **Level groups** (`pipeline/inference.ts`'s `buildLevelGroups`) - group
   by identical count, then union-find cluster same-count columns pairwise
   bijective with each other, via `pipeline/queries.ts`'s
   `containmentHolds`/`bijective`.
5. **Chain** (`pipeline/inference.ts`'s `buildChain`) - longest-path DP over
   the full containment/embedding DAG between every group pair, not just
   cardinality-adjacent ones.
6. **Role assignment** (`pipeline/inference.ts`'s `assignChainRoles`) - per
   level, per column, independently: `code` if it embeds a resolved parent
   column or looks code-shaped, `name` otherwise.
7. **Bracketing** (`pipeline/inference.ts`'s `bracketOtherColumns`/
   `bracketLevel`) - leftover columns slotted into the nearest chain level
   by cardinality range, resolved to `name`, `supplemental`, or
   `ambiguous`.
8. **Sort + output** (`pipeline/inference.ts`'s final sort,
   `pipeline/outputs.ts`'s `writeCrosswalkTable`) - finest-level-first
   ordering, written to a `sm_crosswalk` DuckDB table for CSV export via
   `$lib/db/export.ts`.

## Why the edge-validity rule has three branches

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

## Why role assignment never defers to a sibling

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

## Why a losing bracket candidate is "supplemental," not always "ambiguous"

A bracketed candidate that passes a one-way function check against a
level's code column, but isn't itself bijective with it, cannot be a
same-level rival: by pigeonhole, a function between two equal-cardinality
finite sets is automatically one-to-one, so failing bijection means the
candidate has strictly different (coarser) cardinality. It's a genuine,
independently-defined coarser grouping, not noise, hence a distinct
`supplemental` label from `ambiguous` (topo-tools-py's ADR-0065). A
candidate failing the function check in both directions has no defensible
relationship to report at all, and stays `ambiguous`.

## Query shape

Every relational check (`COUNT(DISTINCT)`, containment, embedding,
bijection) is its own small, targeted DuckDB query in `pipeline/queries.ts`,
run for one column pair at a time and orchestrated by TypeScript loops in
`pipeline/inference.ts`. Candidate columns run to single digits or low
dozens per file, so the total query count (roughly quadratic in column
count for chain-building) stays cheap; this mirrors topo-tools-py's own
structure of Python loops around individual `conn.execute()` calls, and
this app's own `dissolve` precedent of a query shape that scales with
column count, not row count.

## Row-order determinism

This app runs DuckDB WASM with `preserve_insertion_order = false` (see
`docs/reference/shared.md`), so a plain `SELECT * FROM sm_crosswalk` is not
guaranteed to return rows in insertion order. `writeCrosswalkTable` stores
an explicit `column_order` column, and `$lib/db/export.ts`'s `schema_map`
source config selects with `ORDER BY column_order`, mirroring
topo-tools-py's own explicit `ORDER BY column_order` at CSV-export time.

## Verification

Cross-checked against topo-tools-py's own `schema-map` CLI on three real
files from the portolan catalog: `cod/latest/adm2/original.parquet` (a
clean 3-level chain with the `area_sqkm`/`adm2_pcode1` role-assignment
case above), `mdg/latest/mgd_op_adm1_old_names_pcodes/original.parquet`
(the constant-admin0-then-two-nesting-code-levels case exercising the
no-embedding-anywhere fallback), and `mdg/latest/adm4/original.parquet` (a
full 5-level chain, 17,465 rows). All three produced identical
`source_column`/`target_column`/`unique_count`/`note` values and row order
to the Python CLI's output, modulo one cosmetic CSV-writer difference:
DuckDB's `COPY ... (FORMAT CSV, HEADER)` quotes an empty *string* as `""`
to distinguish it from a NULL, where Python's `csv` module writes both
identically as a bare empty field. Both represent the same value once
parsed.
