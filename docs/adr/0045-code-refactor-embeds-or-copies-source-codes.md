# 0045: Code Refactor embeds or copies source codes

## Status

Accepted. Ports topo-tools-py ADR 0122 (topo-tools-py #160, #168).

## Context

COD-AB p-codes released in 2026 are the country's ISO2 code followed by
each level's government code, concatenated (`BH51030366`). Code Refactor
re-ranked every source value, because raw values can be gappy, duplicated
or non-numeric, so it couldn't publish the government codes themselves. A
level with names but no code column also had nothing to rank.

## Decision

Code Refactor takes a source-codes mode (URL `source`):

- `replace` (default): every level is re-ranked.
- `embed`: a level with a source code column is its parent's code, then
  the delimiter, then its own source value.
- `copy`: as `replace`, after copying each level's source code column to
  its next free numbered sibling (`adm1_code1`, `nextFreeSibling` in
  `$lib/db/adminColumns.ts`).

Under every mode, a row with no source code at a numbered level raises,
and with explicit field templates, a level with a name column but no
codes gets codes seeded from its names (`detectLevels` with
`requireCodes: false`), ranked under its parent by name.

## Consequences

A seeded level's numbers follow alphabetical name order, so they shift
when a sibling is added or renamed. A file with blank codes at a level
needs them filled, or the level coded from names, before it can be coded.
