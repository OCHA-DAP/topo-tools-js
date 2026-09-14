# 0033: A detected level's `GROUP BY` clause must use anchor-filtered identity columns, not raw `groupBy`

## Status

Accepted.

## Context

`schema-map/pipeline/levelColumns.ts`'s `LevelColumns` carries two related
but distinct column lists per level: `groupBy` (every column
`resolveColumns` assigned a structural role at that level, unfiltered by
naming) and `identityColumns` (the subset already restricted to columns
matching the level's own naming anchor, via `isLevelIdentityColumn`). At a
file's finest detected level, every column is trivially row-unique (each
group has exactly one member), so `resolveColumns`'s cardinality-based
role assignment can't distinguish the real code column from an incidental
numeric or struct column that happens to also be unique at that level.

Running `package-points` against a real 4-level Gambia compound-pcode
portolan file (`gmb_admin3.parquet`, 115 distinct `adm3_pcode` values, no
duplicate groups at the finest level) surfaced this: `area_sqkm`,
`center_lat`, `center_lon`, and a `bbox` struct column were all swept into
level 3's raw `groupBy`, then excluded from every other level's own
dissolve (since `package-points`' auto-detect path excludes every *other*
level's `groupBy`-derived identity set), producing `NULL` instead of the
real, correctly-summed value at every level above the finest.

## Decision

Wherever a detected level's `groupBy` is used as an actual SQL `GROUP BY`
clause or an identity-exclusion set, intersect it with that level's own
`identityColumns` first: `cols.groupBy.filter(c => identitySet.has(c))`,
throwing if the result is empty. Applied in `package-polygons/pipeline/index.ts`,
`package-points/pipeline/points.ts`, and `package-lines/pipeline/boundaries.ts`.

## Consequences

`identityColumns` was already computed for exactly this purpose
(`schema-map/pipeline/levelColumns.ts`'s own anchor-filtering logic); no
new detection logic was needed, only using the already-correct field
instead of the unfiltered one. `package-polygons` never actually dissolves
its own finest level, so it was not exposed to this bug in practice, but
the same filter was applied there defensively for consistency, since the
same `LevelColumns` shape is used across all three package-* tools.
