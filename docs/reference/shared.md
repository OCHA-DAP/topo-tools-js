# shared

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention. Rules here
apply across more than one tool; a tool's own file references this one by
name instead of repeating them.

## Runtime

- All processing MUST run client-side, in DuckDB WASM. No input file or
  derived geometry MUST be sent to a server.
- The DuckDB session MUST run with `threads = 1`,
  `preserve_insertion_order = false`, and `geometry_always_xy = true`.
- A query that plans as `SPATIAL_JOIN` (a bare `ST_Intersects`/`ST_Within`
  predicate in a `JOIN ON` clause) pre-reserves memory proportional to
  `memory_limit`, which becomes a real allocation in WASM. Any such join
  MUST either be rewritten with bounding-box predicates (so it plans as
  `PIECEWISE_MERGE_JOIN`) or MUST temporarily raise `memory_limit` around
  the join and restore it afterward.

## Supported formats

- Loading MUST accept GeoJSON, GeoJSONL, GeoParquet, GeoPackage, Shapefile
  (as a `.zip` of its component files), FlatGeobuf, KML, GML, and GPX. A
  dropped `.zip` MUST be expanded and its contents matched against these
  formats before rejecting the input.
- GeoParquet MUST be loaded via `read_parquet`, not `ST_Read`. Every other
  format MUST be loaded via `ST_Read`.
- Exporting spatial results MUST offer GeoParquet always, plus whichever
  GDAL drivers the loaded spatial extension build reports as
  `can_create` from among GeoPackage, Shapefile, FlatGeobuf, KML/LIBKML,
  and GML. A driver absent from the current build MUST NOT appear as an
  option. GeoJSON export MUST be served from an already-cached string
  rather than a GDAL driver, when a cached copy is available.
- A GDAL export MUST declare `SRS 'EPSG:4326'` explicitly, since loaded
  geometry carries no other CRS.

## Loading and normalization

- Loading MUST reproject every input geometry to EPSG:4326, run
  `ST_MakeValid`, and force it to 2D, before any tool-specific stage runs.
- Loading MUST assign a stable `fid` to every feature (`row_number()` over
  the load order) if the source format doesn't already carry one.
- A GeoParquet file whose embedded `geo` metadata cannot be parsed (e.g. a
  malformed field) MUST still load, by stripping that metadata and reading
  the geometry column as raw WKB instead of failing outright.
- A GeoJSON or GeoJSONL feature carrying a property literally named
  `OGC_FID` MUST have it renamed before loading, to avoid colliding with
  `ST_Read`'s own reserved FID column of the same name.
- Re-registering a same-named file within one session MUST NOT reuse a
  prior registration's name — each load MUST use a fresh, session-unique
  registered name.

## Coverage-topology checks

- The shared overlap/mismatched-edge check (`ST_CoverageInvalidEdges_Agg`)
  MUST NOT be treated as a gap check: it reports "no violations" both when
  a real, fully-enclosed gap exists with no overlaps, and when the input
  has collapsed to nothing.
- The shared gap check MUST detect fully-enclosed interior holes only, in
  the union of a layer's own geometries. An open, non-enclosed inlet
  between two polygons MUST NOT be reported as a gap.
- A "clean this derived output" pass MUST first check for a coverage
  violation and skip `ST_CoverageClean` entirely when none is found. Every
  caller that wants this behavior MUST go through `gatedCoverageClean`
  rather than calling `ST_CoverageClean` directly.
- `gatedCoverageClean` MUST preserve the input's fid set: a feature that
  `ST_CoverageClean` collapses to empty MUST fall back to its pre-clean
  geometry rather than being dropped.
- A `gatedCoverageClean` failure MUST be caught and logged, leaving the
  target table untouched, rather than propagated to the caller.

## Overlap measurement (`$lib/db/overlap.ts`)

Shared by `match` (parent/child assignment) and `change` (version-to-version
comparison).

- Overlap measurement MUST compute exact geometric intersection
  (`ST_Intersection`); a failure MUST propagate to the caller rather than
  falling back to an approximation.
- An intersection piece with area below the sliver threshold (~1cm²) MUST
  be discarded before it contributes to any pair's shared area.
- Area and ratio calculations (`coverage_a`, `coverage_b`, `iou`) MUST use
  an equal-area projection, not raw EPSG:4326 degree-area.

## Code-based assignment override (`$lib/db/codeJoin.ts`)

Shared by `match`, `mosaic`, and `clip` for parent assignment.

- Callers MAY supply a `matchColumn` name (same column on both layers) or a
  `parentMatchColumn`/`childMatchColumn` pair (different names), mutually
  exclusive with each other. Supplying only one of the pair MUST raise.
- When supplied, an exact code join, restricted to `(child, parent)` pairs
  that already spatially overlap, MUST win over the default
  spatial-majority-vote assignment wherever a code match exists, even when
  it disagrees with the spatial result. A child (or, for assign-one, a
  whole file) whose code has no overlapping-parent match MUST fall back to
  the spatial result (see `docs/adr/0029`).
- The outcome MUST be recorded as `assignmentMethod: 'code' | 'spatial_fallback'`
  and `spatialAgrees: boolean | null` (`true`/`false` when the method is
  `'code'`, `null` when it's `'spatial_fallback'`).
- A disagreement or fallback MUST surface as an issues row: `kind='code-mismatch'`
  when the code match won but disagreed with the spatial result, or
  `kind='code-fallback'` when no code match existed. `unitA` MUST hold the
  child's own fid, `parentFid` the winning parent's fid.
- Omitting both parameters MUST leave assignment behavior and output schema
  unchanged for existing callers.
