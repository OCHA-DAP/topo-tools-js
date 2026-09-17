# Code Refactor

Cold-starts a hierarchical code on any flat, finest-level input: no
existing code column is assumed, only a hierarchy embedded as columns
(the same shape `package-polygons`/`schema-fill` expect). Ported from
topo-tools-py's `code-refactor`. Attribute-only, no geometry touched.

## Pipeline

1. **Load** (`$lib/db/loader`), loads the input layer via the shared
   loader, same as every other tool.
2. **Resolve levels** (`pipeline/levels.ts`'s `resolveCodeLevels`), reuses
   `package-polygons`'s own two-path contract: an explicit name/code
   field template pair first, and if both are omitted, structural
   auto-detection (`schema-map`'s `detectLevelColumnsOrSingle` +
   `verifyFunctionalCluster`) takes over. Zero levels detected throws,
   since a hierarchy that can't be located at all has nothing to rank. A
   resolved level with no code column at all also throws: this tool only
   ever overwrites an existing column's values, it never creates one.
3. **Assign** (`pipeline/assign.ts`'s `assignRefactorCodes`), chains
   level to level, ascending: rank that level's own raw values under
   their immediately-coarser level's already-assigned code (or the
   literal root code, for level 1), and overwrite the column in place
   via `assignNewCodes` (`$lib/db/code`). Unlike `package-polygons`'s
   independent per-level dissolves, this deliberately chains: ranking a
   level's units requires that level's own parent code to already exist,
   so level 2 can't be assigned until level 1's own assignment has
   produced real parent codes to group under.
4. **Issues** (`pipeline/issues.ts`'s `buildCodeIssues`), groups distinct
   assigned codes per level by their own parent prefix, flags any group
   whose count exceeds `10 ** minWidth - 1`, and reports the parent's own
   highest-tail-integer assigned code alongside the count. Always
   (re)writes the `cr_issues` table, empty when nothing overflowed.
5. **Export** (`pipeline/index.ts`), the finest-level table, every
   resolved level's code column now overwritten in place, is exported as
   the main output.

## Renumbering and the root code

Resolved levels are renumbered to a clean `1..N`, coarsest first,
regardless of how many raw columns existed or what they were named. A
genuinely constant coarsest column (a single-country file's own admin0
code, for instance) never becomes a level; it's dropped before
renumbering. This is why the root code is never stamped as its own
output column: level 1 already has a real parent, the root code string
itself, so there's no level 0 for it to occupy.

## Every value is re-ranked, never passed through

Every source value is re-ranked into a fresh integer before formatting,
never passed through as-is: a raw hierarchy column (a GADM-style
`AFG.1_1`, or a plain integer with gaps) is rarely clean enough to
zero-pad directly, and even when it happens to look clean, nothing
guarantees it's unique or gap-free across every sibling group in the
file.
