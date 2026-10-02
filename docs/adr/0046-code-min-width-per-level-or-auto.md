# 0046: Code min width per level or auto

## Status

Accepted. Ports topo-tools-py ADR 0123 (topo-tools-py #160).

## Context

One min width for every level can't express a scheme whose levels pad
differently (2-digit admin1, 4-digit admin3). Code Update detected one
width pooled across levels, so it miscoded an OLD file whose levels
differ.

## Decision

- `MinWidth` is one width (`3`), one width per numbered level, coarsest
  first (`2,2,4`, exactly one entry per level, else an error), or `auto`,
  parsed by `parseMinWidth`. Both code tools take it as a text field.
- `auto` pads every new code at a level to the widest tail that level
  needs, retained codes included, so the level never overflows and has
  no overflow report.
- `detectCodeFormat` takes the most common width at each component
  position, returning one width when every level agrees.

## Consequences

Under `auto`, a level's width can change between releases as its largest
parent grows, changing every code at that level. A width list needs each
level's child counts known in advance.
