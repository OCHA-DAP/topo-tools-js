# 0031: Spatial coherence as a safety net for two exploitable chain-justification paths

## Status

Accepted. Ports
[topo-tools-py ADR-0100](../../../topo-tools-py/docs/adr/0100-spatial-coherence-safety-net-for-chain-justification.md).

## Context

`schema-map`'s structural matcher (`pipeline/inference.ts`) justifies a
chain edge either by direct embedding evidence or, absent that, two
narrower exceptions: a finer group chaining off a genuine file-wide
constant root for free (`inRootPrefix`), and `embeds()`'s own tolerance for
exactly one distinct non-embedding "culprit" value. Both exceptions are
needed for real files (a genuine admin0 constant with no compound code; a
missing-value sentinel like a repeated `"No_Pcode"`), but both are also
exploitable by an audit/workflow column that happens to satisfy the same
cheap statistical test without carrying any real geographic information.
topo-tools-py's real-data survey (ADR-0100) found this on Moldova
(`update_by` falsely tolerance-embedded a `created_user` root constant) and
Colombia/Ecuador/Tunisia/Greece (`update_by` chained off the root for free,
then `created_user` chained off `update_by`, outranking the real
`root -> adm1_pcode` chain purely on path length).

Upstream also tried, and rejected, a blanket spatial-coherence filter on
chain candidacy generally, mirroring the existing temporal-column
exclusion: Belgium's Brussels-Capital enclave and Costa Rica's
coast-to-coast wedge provinces both score low R² on their real,
correctly-partitioned `adm1_pcode`, so a blanket filter demoted both to
`supplemental`, a new regression on top of fixing the original six.

## Decision

Spatial coherence (`queries.ts`'s `spatiallyCoherent`) corroborates only
the two specific exploitable paths above, never chain candidacy generally:

- A finer group's edge into the root, justified *only* by the root freebie
  (no embedding evidence), additionally requires the finer group to be
  spatially coherent, unless the table has no `geom` column loaded at all
  (`hasGeometryColumn`).
- `embeds()`'s one-culprit tolerance is trusted only if the child column is
  also spatially coherent, same no-geometry exemption.

A column reaching the chain through direct, tolerance-free embedding never
passes through either check. Coherence itself is
`R² = 1 - (pooled within-group centroid variance) / (file-wide centroid variance)`,
thresholded at `0.7`, and returns `true` (not evidence against) below
`MIN_ROWS_FOR_SPATIAL_COHERENCE = 10` total evaluated rows, since a low-N
variance estimate is unreliable rather than genuinely incoherent.

## Consequences

A table with no `geom` column loaded degrades to the exact pre-existing
behavior (neither check applies), so `resolveColumns` itself stays
unaffected and only `buildChain`/`embeds` internals change. The same
root-prefix restriction that scopes the root freebie
(`orderGroupsByContainment` plus the unbroken fully-populated prefix check
in `buildChain`) also blocks a sparse, non-root single-value column from
ever reaching either corroboration path in the first place.
