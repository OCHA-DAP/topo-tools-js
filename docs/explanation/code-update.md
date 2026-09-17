# Code Update

`code-update` reconciles an already-coded OLD layer against an uncoded
NEW candidate: classify what changed via `change`'s own engine, then
apply the standard changelog-driven retention policy so a unit's code
survives, gets replaced, or retires. Ported from topo-tools-py's
`code-update`.

## Table shape: split geometry/attribute tables, not one combined table

Every other tool in this app loads a file into a split `{prefix}layer_01`
(fid+geom) and `{prefix}layer_attr` (fid+attrs) pair, never one combined
table (`$lib/db/loader`). `code-update` resolves levels against each
side's `_layer_attr` table, then builds a joined `cu_a_input`/`cu_b_input`
table (fid+geom+attrs) ahead of the per-level dissolve loop, since dissolve
needs both geometry and the level's own code/name columns together. Final
output is written onto `cu_b_layer_attr` and exported by joining it back
against `cu_b_layer_01`, the same split-table `tableToGeoJSON` convention
every other tool uses.

## Level resolution and format detection

OLD's and NEW's own per-level code/name columns are resolved
independently, each via the identical explicit-pair-or-structural-
fallback contract `code-refactor` uses. A resolved level with no code
column at all raises: neither side's resolution ever creates a column, so
a codeless level needs an explicit template pointed at a real one. A
level-count mismatch between the two resolutions raises immediately,
before any dissolve or classify work starts.

`detectCodeFormat` runs against OLD's own resolved finest level, never
the root: a root-only value has no delimiter occurrence to infer anything
from, while the finest level gives the richest sample for both delimiter/
root detection and the width mode. Each of `rootCode`/`delimiter`/
`minWidth` falls back to the detected value independently, only when that
field itself wasn't explicitly given.

This app does not expose a separate identity-linking override distinct
from a level's own resolved code/name column (Python's
`code_column_a`/`b`/`name_column_a`/`b` flags have no JS equivalent):
`linkByCode`/`linkByName` always compare each side's own resolved code/
name column at that level. A `relocated` unit (spatially disjoint from
its OLD polygon) still gets identity-linking rescue when its resolved
name column matches, the common case; a persistent identifier genuinely
distinct from both the code and name columns falls outside this tool's
current scope.

## Dissolve: independent per side, per level

OLD and NEW are dissolved independently at every level, always from that
side's own original `cu_{side}_input` table (never chained from a
coarser level's own dissolve output), reusing `package-polygons`'s own
`runDissolveCore`: OLD grouped by its own already-real code column, NEW
grouped by its own resolved (structural or explicit) raw column.

## Classify: reusing `change`'s stage function directly, per level

Each level's two dissolved tables are copied into the fixed table names
`polygon-changelog`'s own `stageClassify` expects
(`cw_a_keyed`/`cw_b_keyed`), which then runs unmodified, producing
`cw_pairs_classified` (`a_fid`, `b_fid`, `match_method`) and
`cw_polygon_class` (`side`, `fid`, `cluster_id`, `relationship_class`).
`assignLevel` reads both tables directly via SQL immediately afterward,
before the next level's `classifyLevel` call overwrites them, rather than
threading `stageClassify`'s in-memory return value through a function
chain: this mirrors Python's own per-level file-based handoff more
closely than passing a JS object would, and keeps `assignLevel` a plain
consumer of the same two tables regardless of how many levels ran before
it.

## Reparent: re-derived spatially, never trusted from an embedded column

For every level finer than the coarsest, each NEW unit's true current
parent is re-derived spatially against the immediately-coarser level's
NEW, already-dissolved units, via `assignBestOverlap` (`$lib/db`, shared
with `match`'s own per-child best-overlap assignment), never read off a
raw embedded parent column. A raw parent-reference column goes stale
exactly when the coarser unit was itself split, merged, or relocated this
same version.

## Assign: one retention policy, six shapes of change funneled through two code paths

Every relationship class reduces to one of two things happening to a
unit's code: it's **retained** (rewritten under a possibly-new parent
prefix, never re-ranked) or it's **replaced** (assigned fresh through the
same batched `assignNewCodes` call `code-refactor` itself uses).

`unchanged` and `renamed` are the only retained classes: `rewriteChildCode`
reattaches the OLD code's own tail onto the (possibly new) parent prefix,
a no-op reconstruction when the parent didn't change and a genuine prefix
cascade when it did.

Every other class (`modified`, `relocated`, `created`, `split`, `merge`,
`complex`) funnels into one shared per-level batch: every new-code
request for that level is collected into a `cu_assign_new` staging table
and assigned in one `assignNewCodes` call, seeded with
`existingCodes: retainedCodes` (this level's own just-computed retained
set), so a freshly assigned code can never collide with one a sibling
just kept. This is also why a code retired this run (a `merge`'s two old
codes, a `removed` unit's own code) can be immediately reused by an
unrelated new/split/merge/created unit at the same level in the same run.

`match_method` is collapsed per cluster: a cluster spanning exactly one
old/new pair keeps that pair's own value (`"spatial"` or `"identity"`)
untouched; a cluster spanning multiple linked pairs unions every linked
pair's own method and joins with `"+"` only when genuinely mixed.

`predecessorCode` stays a scalar field: `null` for `created` and for
every retained row, the one linked OLD code for `modified`/`relocated`,
the one shared OLD code for every `split` child, and `null` again on a
`merge`/`complex` survivor's own row, since a scalar can't losslessly
hold more than one predecessor. Full N:M lineage for a `merge`/`complex`
cluster lives in the changelog instead (every retired `old_code` row
shares that cluster's own `cluster_id`).

## Outputs: writing under OLD's own column names

Each level's new code is written into the column name OLD's own
resolution used at that level, in place on `cu_b_layer_attr`; NEW's own
raw column at that level, if differently named, is left untouched as an
ordinary passthrough attribute. `predecessor_code` is populated only for
the finest level's own rows, joined back by the raw NEW value captured
right after that level's own dissolve, before that value's own column
gets overwritten later in the per-level loop.

The changelog is always written, even when it would be empty: a
`removed` code gets one row with `new_code=null`, a `created` code gets
one row with `old_code=null`, a `merge` gives N retired rows plus one new
row, and a `complex` cluster gives one row per actually-linked old/new
pair, never a full N×M cross-product. The changelog table itself has no
`predecessor_code` column (that lineage lives only on the output layer's
own attribute table), matching Python's own changelog schema exactly.

## UI scope: no per-feature outcome coloring on the map

The shared `MapView` component supports only fixed-color original/result
layers, no categorical or property-based fill. `code-update`'s result map
renders as a plain result layer over the NEW input, and the changelog
table (with its own outcome-count summary) is the only place
`code_outcome` is visible, rather than a `REL_COLORS`-style legend on the
map itself.
