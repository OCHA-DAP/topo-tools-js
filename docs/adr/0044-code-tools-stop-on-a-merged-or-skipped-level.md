# 0044: Code tools stop on a merged or skipped level

## Status

Accepted. Ports topo-tools-py ADR 0121 (topo-tools-py #159, #168).

## Context

On BHR v01 admin3, structural detection missed a name-only admin2 level
whose names repeat across admin1 units, and the code tool took
`adm3_name` as admin3's code column and overwrote it with no error. A
nesting share can't tell a missed level from an attribute column: real
intermediate levels with parent-local codes nest 11 to 29% by value,
attribute columns 100%. ADR 0043 ported the Schema Map side of this
(`breakShapeTie`, `supplementalColumns`, the coarser-member check); Code
Refactor and Code Update still coded such files silently.

## Decision

In structural mode, both code tools raise when detection sets any column
aside as a supplemental coarser grouping, naming the columns and asking
for explicit field templates, and call `verifyFunctionalCluster` with the
parent level's code column, so a cluster member that collapses under its
parent raises.

## Consequences

Structural coding stops on files with a supplemental attribute column
(`pays`, `edit_par`, `SOURCE`), which then need explicit name/code field
templates. Structural detection still misses intermediate levels whose
codes are local to each parent.
