# 0049: Code Update never reuses a code and reads codes without a delimiter

## Status

Accepted. Ports topo-tools-py ADR 0126 (topo-tools-py #163, #169).

## Context

Releases keep ISO2-style codes with no delimiter (`SN0101`) until a bulk
migration to `ISO3.NNN`, so Code Update meets both formats in a previous
release. A code retired in a run could go to a different unit in the
same run, and a unit moved under a new parent could be rewritten onto a
code that parent already held. A previous release's names-only level has
no code column to carry over.

## Decision

- New numbers start above every code each parent had in OLD, retired
  codes included.
- A retained code whose rewrite under a new parent repeats an OLD code, or
  an earlier rewrite, gets a new code, with its OLD code as predecessor.
- Without a delimiter, the format is detected from OLD's per-level code
  columns (`detectUndelimitedFormat`): the root is level 1's leading
  non-digit run, and each level's width is the length it adds to its
  parent's code. Min width `auto` with no delimiter raises. The delimiter
  field is a select: Auto-detect (URL parameter absent), None
  (`delim=none`), or Character.
- With explicit templates, a level 0 code column is left untouched, and a
  NEW level with only a name column is seeded from its names.
- Strict or lenient follows the code format: without a delimiter, a
  `modified` 1:1 match keeps its code; with one, it gets a new code.
- A run raises on a missing code, or a code with more than one name, at
  any level of either side.

## Consequences

No code is reissued across consecutive releases. A code retired two or
more releases back isn't tracked. Codes without a delimiter keep
continuity through re-digitising, but don't promise identical geometry.
