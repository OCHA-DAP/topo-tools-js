# Package Polygons

`package-polygons` replaces the standalone `dissolve` tool: instead of a
single caller-picked `groupBy` column list, it auto-detects every admin
level present in a polygon layer and produces one dissolved output per
level in a single run. Level detection is structural by default
(`schema-map`'s cardinality/containment matcher, no naming convention
assumed); supplying an explicit `nameField`/`codeField` pair uses that
naming convention instead. It reuses this app's own dissolve primitive
(`pipeline/dissolveCore.ts`'s `runDissolveCore`), the richer, schema-aware
successor to the old `dissolve` tool's aggregation logic. Ported from
topo-tools-py's `package-polygons`.

## Pipeline

1. **Load** (`$lib/db/loader`, shared), then `pipeline/index.ts` joins
   `layer_01`/`layer_attr` into a working `pp_input` table.
2. **Resolve level plans** (`resolveLevelPlans`) - on the explicit-schema
   path, `schema-fill/pipeline/levels.ts`'s `detectLevels` finds every
   level, and each level's `groupBy` is its own `codeField`. On the
   auto-detect path, `schema-map/pipeline/levelColumns.ts`'s
   `detectLevelColumns`/`detectLevelCodes` structurally find every level;
   each level's `groupBy` is filtered down to the anchor-conforming subset
   of `identityColumns` (see "Why `groupBy` alone isn't safe" below),
   `verifyFunctionalCluster` confirms that subset doesn't fragment the
   level's own canonical code column's groups, and `exclude` is every
   finer level's own `identityColumns`, so no numbered ancestor column
   ever survives under its own name.
3. **Dissolve** (`runDissolveCore`, `pipeline/dissolveCore.ts`) - one call
   per level coarser than the finest. The finest level is never dissolved:
   its output is `layer_01`/`layer_attr` directly, since grouping by its
   own finest code column would be a no-op.
4. **Issues** (`pipeline/issues.ts`'s `buildPolygonIssues`, reusing
   `$lib/db/coverage.ts`'s `gapRegionsQuery`) - a gap-only report per
   level, the same shape the old `dissolve` tool used.

## Why `groupBy` alone isn't safe

`LevelColumns.groupBy` (from `schema-map/pipeline/levelColumns.ts`) is the
raw, unfiltered set of columns `resolveColumns` assigned a structural role
at that level. At a file's finest level, every column is trivially
row-unique (each group has exactly one member), so an incidental numeric
or struct column can get swept into `groupBy` alongside the real code
column, purely because uniqueness alone can't distinguish it from one.
`LevelColumns.identityColumns` is already filtered by naming anchor
(`isLevelIdentityColumn`), so intersecting `groupBy` with `identityColumns`
before using it as a `GROUP BY` clause removes that false-positive risk
(`docs/adr/0033`).

## Export registry

`export.ts` registers eight bounded per-level `ExportSource` keys
(`package_polygons_level_0` through `package_polygons_level_7`), each
pointing at a predictable table pair (`pp_geom_{n}`/`pp_attr_{n}`) the
pipeline always writes to for whatever levels it actually detects.
`App.svelte` only renders a `DownloadMenu` for a level index present in
that run's own `levels` array.
