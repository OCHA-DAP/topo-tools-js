# Code

`$lib/db/code.ts` is the shared hierarchical-code primitive behind
`code-create` and `code-update`: a leaf module with no dependency on
either tool, ported from topo-tools-py's `core.code`.

## `CodeFormat`

```ts
type MinWidth = number | number[] | "auto";

interface CodeFormat {
  rootCode: string;
  delimiter: string;
  minWidth: MinWidth;
}
```

No field has a default. `resolveCodeFormat(rootCode, delimiter, minWidth,
{ allowEmptyDelimiter })` is a thin validating constructor: non-empty
root, single-character delimiter (or empty, when allowed), and a
`minWidth` parsed by `parseMinWidth`. `rootCode` is opaque everywhere,
never shape-checked, so a disputed-territory prefix works identically to
an ISO3 one.

`minWidth` takes three forms (py ADR 0123): one width for every level
(`3`), one per numbered level, coarsest first (`2,2,4`), or `auto`.
`widthFor(fmt, level)` returns a level's width (levels count from 1), or
`null` under `auto`. A list is for schemes whose levels pad differently
(2-digit admin1, 4-digit admin3); `checkLevelCount` throws unless it has
exactly one entry per numbered level, since a short list would silently
pad the deepest levels wrong.

An empty delimiter is for ISO2-style codes (`AF0101`), which COD-AB
releases keep until a bulk move to `ISO3.NNN` (py ADRs 0125, 0126). Such a
code can only be split by width, so `parseCode` strips the root and cuts
each level's tail at that level's width. Every function that splits a
code (`parentPrefix`, `lastComponent`, `rewriteChildCode`) inherits that.

## Cascade: ranking, not reformatting

`assignNewCodes(conn, table, opts)` is the one function both tools use to
mint new codes. It never reformats a raw source value in place: rows are
ranked per `parentColumn` group by `sortColumns`
(`ROW_NUMBER() OVER (PARTITION BY parentColumn ORDER BY sortColumns)`),
numbered from just above every integer the parent's direct children use
in `existingCodes` (`usedIntegers`), then formatted as `parentCode ||
delimiter || lpad(tail, width, '0')`. A raw source value is never
trustworthy enough to zero-pad and reuse directly: it may be non-numeric,
gappy, or duplicated across siblings. `code-create`'s `embed` mode is the
deliberate exception, for government codes that are the identifiers being
published.

`code-update` passes every OLD code at the level, retired ones included,
so a number retired in a run is never handed to a different unit in the
same run (py ADR 0126).

Without a delimiter at a fixed width, codes at the top of a level's range
are often placeholders (`ET99` for contested areas, `98`/`99` for lakes).
When the next number above a parent's highest code doesn't fit the width,
numbering continues above its highest code below the top 10% of the range
(`90` at width 2), and throws if it would reach that cutoff (py ADR 0127).
With a delimiter, numbering always starts above the highest code.

## Overflow: width grows, it never repads

`lpad` truncates an over-width string, so `assignNewCodes` widens its own
target width to `GREATEST(width, LENGTH(tail))` before padding. A parent's
1000th child at width 3 gets a 4-digit tail; every child ranked below it
keeps its own already-assigned 3-digit code untouched, no whole-parent
repad. Without a delimiter a longer tail couldn't be split again, which is
why that case throws instead (above).

Under `auto`, every new tail at a level pads to the widest tail that level
needs, `existingCodes` included, so the level never overflows. The cost is
that a level's width can change between releases as its largest parent
grows, changing every code at that level.

`code-create` and `code-update` each detect and report overflow at fixed
widths in their own outputs stage; `code.ts` itself has no reporting
concept, only the underlying width behavior.

## Format detection

`code-update` detects OLD's format from its own codes, rather than
requiring a caller to state it. `hasDelimiter` decides which detector
runs: whether any sampled code in OLD's finest code column has a
non-alphanumeric character.

`detectCodeFormat(conn, table, codeColumn)` works from a sample of up to
10,000 distinct, non-null values of one delimited column:

- **delimiter**: the single non-alphanumeric character common to every
  sampled code. Zero or more than one candidate throws.
- **root**: the shared first delimiter-split component. Not constant
  across the sample throws, since that means `codeColumn` isn't actually
  this dataset's own root-anchored hierarchy column.
- **min width**: each component position's most common width (first seen
  on ties), returned as one width when every position agrees. The mode,
  not the max, keeps one overflow-widened tail from skewing a level, and
  per position, not pooled, keeps a 2-digit admin1 from being read as
  admin3's width.

`detectUndelimitedFormat(conn, table, levelColumns)` reads one code column
per level instead, since an undelimited code can't be split without its
widths: the root is level 1's leading non-digit run, which every code must
share, and each level's width is the single length it adds to its
parent's code.

Any field that can't be confidently inferred throws rather than falling
back to a hardcoded literal; `code-update` accepts an override for any
subset of root, delimiter and min width.

## Rewrite: cascading a parent's new prefix

`rewriteChildCode(oldCode, newParentCode, fmt)` reattaches `oldCode`'s own
final (tail) component onto `newParentCode`, leaving the tail integer and
its sibling ranking untouched. This is the one function that lets
`code-update` cascade a coarser unit's new code down through every
unchanged/renamed descendant without re-ranking them: only the unit whose
own identity changed gets a fresh number through `assignNewCodes`;
everything nested under it that didn't change keeps its own relative
position, just under a new prefix.

## Seeding codes from names

A level with names but no code column (a names-only admin2 between coded
admin1 and admin3) has nothing to rank or match on. `seedCodeFromNames`
fills the code column with the level's names so the usual machinery
applies, and `checkUniqueNames` throws when a name repeats under one
parent, since seeding would merge those units into one.

## Pure string operations

`parseCode(code, fmt)`/`buildCode(components, fmt)` split/join a code.
`parentPrefix(code, fmt)` drops a code's own last component (throws, "no
parent", for a root-only, single-component code). `lastComponent(code,
fmt)` returns a code's own final, unpadded component. With a delimiter
these don't validate a code's shape beyond splitting; without one,
`parseCode` throws when the code can't be cut by width.
