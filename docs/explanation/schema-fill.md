# Schema Fill

Cascades every admin-hierarchy column family (code, name, or any other
`adm{n}<suffix>` column) down from its deepest non-empty level, so a row
whose real data stops at, say, admin 2 still has a usable admin 3 value
(copied down from admin 2) instead of a `NULL`. Stamps a new depth column
recording each row's real (pre-fill) depth, since that's the only way to
tell a genuine leaf row from a coarser one apart after filling. Attribute-only,
no geometry touched. Ported from topo-tools-py's `schema-fill`.

## Pipeline

1. **Load** (`$lib/db/loader`), loads the input layer via the shared
   loader, same as every other tool.
2. **Detect levels** (`pipeline/levels.ts`, `detectLevels`), regexes the
   target schema's `code_field` prefix (e.g. `adm`) against `layer_attr`'s
   columns to find every level `1..N` present, `N` being the deepest level
   column found. Raises if a level in that range has no code column of its
   own, or if none is found at all. Opportunistically includes level 0 when
   its own code column exists, without requiring it.
3. **Fill** (`pipeline/fill.ts`, `runFill`), groups every `adm{n}<suffix>`
   column (matched independently against the schema's `code_field` and
   `name_field` prefixes) into families by suffix, then for each family fills
   a `NULL` at level `k` with `COALESCE` over levels `k, k-1, ..., 1`
   (nearest non-NULL shallower level), leaving an already-non-NULL value
   untouched. Appends the depth column, stamped by a deepest-first `CASE`
   over the family's _pre-fill_ code columns.
4. **Export** (`pipeline/index.ts`), joins the filled attributes back onto
   `layer_01`'s untouched geometry and exports.

## Why the depth column reads pre-fill values

DuckDB resolves a same-named column reference in a later `SELECT` expression
against the query's `FROM` clause, not against an earlier item's alias in the
same `SELECT` list, even when that alias shares the column's own name. The
depth `CASE` expression and the fill `COALESCE` expression for the same
column both appear in one `SELECT`, and the depth `CASE` still sees the
original (pre-fill) value, exactly the semantic this tool needs: a row's
depth should reflect how deep its own real data went, not how deep the fill
made it look.

## No topology gate

Schema Fill only touches attribute columns, geometry passes straight through
from `layer_01`. There is nothing here for a topology check to gate: unlike
`clip`/`mosaic`/`match`, this tool never re-clips, re-extends, or otherwise
mutates geometry.

## Where this fits in a pipeline

Intended to run after `match`/`mosaic`, on already-matched-and-clipped
output, the same position topo-tools-py's `schema-fill` occupies. Running it
on raw pre-match source data works mechanically (it only needs the code
columns to exist) but produces a depth column describing the _source_ data's
depth, not the depth of whatever downstream geometry the rest of this app's
pipeline eventually produces.
