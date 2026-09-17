# Code

`$lib/db/code.ts` is the shared hierarchical-code primitive behind
`code-refactor` and `code-update`: a leaf module with no dependency on
either tool, ported from topo-tools-py's `core.code`.

## `CodeFormat`

```ts
interface CodeFormat {
  rootCode: string;
  delimiter: string;
  minWidth: number;
}
```

No field has a default. `resolveCodeFormat(rootCode, delimiter, minWidth)`
is a thin validating constructor: non-empty root, single-character
delimiter, positive `minWidth`. `rootCode` is opaque everywhere, never
shape-checked, so a disputed-territory prefix works identically to an
ISO3 one.

## Cascade: ranking, not reformatting

`assignNewCodes(conn, table, opts)` is the one function both tools use to
mint new codes. It never reformats a raw source value in place: rows are
ranked per `parentColumn` group by `sortColumns`
(`ROW_NUMBER() OVER (PARTITION BY parentColumn ORDER BY sortColumns)`),
starting from `nextAvailableInteger(existingCodes, parentCode, fmt)` for
that parent, then formatted as `parentCode || delimiter || lpad(tail,
width, '0')`. A raw source value is never trustworthy enough to zero-pad
and reuse directly: it may be non-numeric, gappy, or duplicated across
siblings.

`nextAvailableInteger(existingCodes, parentCode, fmt)` scans
`existingCodes` for anything starting with `` `${parentCode}${delimiter}` ``,
skips a tail that still contains the delimiter (a nested, deeper code
under the same textual prefix) or isn't numeric, and returns
`max(found) + 1`, or `1` if nothing matches. It only ever looks at the
`existingCodes` array it's given, never a persisted registry.

## Overflow: width grows, it never repads

`lpad` truncates an over-width string, so `assignNewCodes` widens its own
target width to `GREATEST(minWidth, LENGTH(tail))` before padding. A
parent's 1000th child (at the default `minWidth=3`, capacity `10**3 - 1 =
999`) gets a 4-digit tail; every child ranked below it keeps its own
already-assigned 3-digit code untouched, no whole-parent repad.
`code-refactor` and `code-update` each independently detect and report
this condition in their own outputs stage; `code.ts` itself has no
reporting concept, only the underlying width behavior.

## Format detection

`detectCodeFormat(conn, table, codeColumn)` (used only by `code-update`,
against OLD's own already-coded finest-level column) infers a
`CodeFormat` straight from a sample of existing values (up to 10,000
distinct, non-null), rather than requiring a caller to state it:

- **delimiter**: the single non-alphanumeric character common to every
  sampled code. Zero or more than one candidate throws.
- **root**: the shared first delimiter-split component. Not constant
  across the sample throws, since that means `codeColumn` isn't actually
  this dataset's own root-anchored hierarchy column.
- **min width**: the mode (most common), not the min or max, of every
  non-root component's width, pooled across every level present in the
  column. This specifically avoids an overflow-widened tail at one parent
  skewing the detected width for every other, non-overflowed parent.

Any field that can't be confidently inferred throws rather than falling
back to a hardcoded literal; `code-update` always accepts explicit
root/delimiter/min-width overrides.

## Rewrite: cascading a parent's new prefix

`rewriteChildCode(oldCode, newParentCode, fmt)` reattaches `oldCode`'s own
final (tail) component onto `newParentCode`, leaving the tail integer and
its sibling ranking completely untouched. This is the one function that
lets `code-update` cascade a coarser unit's new code down through every
unchanged/renamed descendant without re-ranking them: only the unit whose
own identity actually changed gets a fresh cascade through
`assignNewCodes`; everything nested under it that didn't change keeps its
own relative position, just under a new prefix.

## Pure string operations

`parseCode(code, fmt)`/`buildCode(components, fmt)` split/join on
`fmt.delimiter`. `parentPrefix(code, fmt)` drops a code's own last
component (throws, "no parent", for a root-only, single-component code).
`lastComponent(code, fmt)` returns a code's own final, unpadded component.
None of these validate a code's shape beyond simple splitting; a
malformed code just produces a malformed result rather than throwing,
except at the two explicit validation points above.
