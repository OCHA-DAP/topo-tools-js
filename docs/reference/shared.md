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
- Every input MAY be loaded from an http(s) URL as well as by drop or
  browse. The download MUST be fetched directly by the browser, never
  through a proxy, and MUST go through the same expansion and format
  matching as a dropped file. A CORS failure, non-2xx status, or HTML
  response MUST show an actionable message in the drop zone.
- A successful URL load MUST write that URL to the page's query string
  under the drop zone's parameter name (`url`, `old`/`new`,
  `input`/`join`, `input`/`overlay`, `crosswalk`), and a local drop or browse
  MUST remove it. Opening a page with that parameter MUST load the URL
  automatically.
- Every tool setting except a column picker MUST sync to a query
  parameter: opening the page MUST apply a valid value before the first
  run, and an invalid one MUST be ignored. Every change MUST write the
  current value, and a value equal to the default MUST remove the
  parameter. Booleans are `true`/`false`.

  | Tool | Parameters |
  | --- | --- |
  | `change` | `match`, `same`, `by` (`geometry`/`identity`), `link` (`either`/`both`) |
  | `code-create` | `root`, `delim` (a character, or `none`), `width`, `source` (`replace`/`embed`/`copy`), `name`, `code` |
  | `code-update` | `root`, `delim` (absent = detect, `none`, or a character), `width`, `name-a`, `code-a`, `name-b`, `code-b`, `code-col-a`, `code-col-b`, `name-col-a`, `name-col-b`, `match`, `same`, `by-code`, `by-name`, `link` |
  | `edge-match` | `fit` (`all`/`each`), `passthrough`, `fill`, `name`, `code`, `depth` |
  | `edge-mosaic`, `edge-stitch` | `fill`, `name`, `code`, `depth` |
  | `package`, `package-polygons`, `package-points`, `package-lines` | `name`, `code` |
  | `schema-map` | `name`, `code`, `level` |
  | `schema-fill` | `name`, `code`, `depth` |
  | `schema-join` | `templates`, `name`, `code`, `overlap` |
  | `topo-clean` | `gap` (see `topo-clean.md`) |
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

## Before/after view (`$lib/components/SideToggle.svelte`)

- Every tool that changes geometry (`topo-clean`, `edge-extend`,
  `edge-match`, `edge-stitch`, `edge-clip`, `edge-mosaic`) MUST offer an
  Original/result toggle once a result exists, showing one side at a time
  and switching to the result after every run. `change` MUST offer the same
  toggle between Version A and Version B.
- `[` and `]` MUST switch sides, except while a text input, select, or
  textarea has focus.

## Loading and normalization

- Loading MUST reproject every input geometry to EPSG:4326, run
  `ST_MakeValid`, and force it to 2D, before any tool-specific stage runs.
- Loading MUST assign a stable `fid` to every feature (`row_number()` over
  the load order) if the source format doesn't already carry one.
- A GeoParquet file MUST be read with its embedded `geo` metadata, so its
  geometry is reprojected from the declared CRS (a column with no `crs`
  entry is OGC:CRS84). If that metadata cannot be parsed (e.g. a malformed
  field), the file MUST still load, by stripping the metadata and reading
  the geometry column as raw WKB taken as EPSG:4326.
- GeoParquet bbox covering columns (a `STRUCT` column named `bbox` or
  ending in `_bbox`) MUST be excluded from the loaded attributes.
- A loaded layer whose extent falls outside [-180, 180] x [-90, 90] MUST be
  rejected with an error naming a missing CRS as the likely cause.
- A GeoJSON or GeoJSONL feature carrying a property literally named
  `OGC_FID` MUST have it renamed before loading, to avoid colliding with
  `ST_Read`'s own reserved FID column of the same name.
- Re-registering a same-named file within one session MUST NOT reuse a
  prior registration's name — each load MUST use a fresh, session-unique
  registered name.

## Coverage-topology checks

- The shared overlap/mismatched-edge check (`ST_CoverageInvalidEdges_Agg`)
  MUST run at `SNAP_TOLERANCE`, so non-matching edges within that distance
  count as violations. It MUST NOT be treated as a gap check: it reports
  "no violations" both when a real, fully-enclosed gap exists with no
  overlaps, and when the input has collapsed to nothing.
- The shared gap check (`buildGapTable`) MUST detect fully-enclosed interior
  holes only, in the union of a layer's own geometries. An open,
  non-enclosed inlet between two polygons MUST NOT be reported as a gap.
- When the exact union throws, the gap check MUST retry the union on
  `ST_ReducePrecision(geom, 1e-11)` and MUST drop every resulting hole whose
  `ST_PointOnSurface` intersects an input polygon. A retry that still throws
  MUST propagate to the caller.
- The shared overlap check (`buildOverlapTable`) MUST intersect every pair
  whose interiors overlap or where one contains the other, through
  `intersectPairs` (see Overlap measurement).
- A "clean this derived output" pass MUST first check for a coverage
  violation or a micro-polygon and skip `ST_CoverageClean` entirely when
  neither is found. On a freshly loaded input (`edge-match`, `code-update`,
  `change`, `edge-extend`), the check MUST also fire on any enclosed hole,
  however narrow. Every caller that wants this behavior MUST go through
  `gatedCoverageClean` rather than calling `ST_CoverageClean` directly.
- `gatedCoverageClean` MUST preserve the input's fid set, apart from
  features the micro-polygon merge removes: a feature that
  `ST_CoverageClean` collapses to empty MUST fall back to its pre-clean
  geometry rather than being dropped.
- A `gatedCoverageClean` failure MUST be caught and logged, leaving the
  target table untouched, rather than propagated to the caller.

## Micro-polygons (`$lib/db/coverage.ts::mergeMicroPolygons`)

- A micro-polygon is any single polygon part (after splitting
  MultiPolygons) whose maximum inscribed circle is at most
  `SNAP_TOLERANCE` across. A wider part MUST be kept, however small its
  area.
- A tool that modifies geometry MUST NOT output a micro-polygon. Where it
  finds one, it MUST merge the part into the feature whose non-micro part
  it overlaps most once buffered by `SNAP_TOLERANCE` (ties to the lowest
  fid, including the part's own feature), or drop it when it touches no
  feature. A feature left with no parts MUST be removed.
- The merge MUST measure each buffered micro part's overlap with its
  candidate features through `intersectPairs` (see Overlap measurement),
  with its snap and grid retries. When the set-based union that rebuilds
  the receiving features throws, the merge MUST rebuild them one by one,
  retrying a feature that still throws with its own parts snapped onto its
  incoming micro parts at `SNAP_TOLERANCE`.
- Every `buildCoverageClean` call MUST merge micro-polygons before
  `ST_CoverageClean` runs, so `edge-extend`, `edge-stitch`, `edge-match`, `edge-mosaic`,
  `topo-clean` and every cleaned input apply this rule. `edge-clip` applies it to
  its clipped output, `topo-clean` again after its fix, and `package-polygons`,
  `package-points` and `package-lines` to their input.
- Each merged or dropped part MUST be reported as a `micro-polygon` row
  by every tool that writes an issues report (`edge-clip`, `edge-stitch`, `edge-mosaic`,
  `edge-match`, `topo-clean` and `package-polygons`), with the part's own fid in
  `unit_a`, the receiving fid in `unit_b` (null when dropped), `reason`
  `merged into neighbouring feature` or `dropped: touches no feature`,
  `fixed` true where the table has that column, and the part itself as
  `geom`. `package-points` and `package-lines` MUST log the count instead.
- `topo-detect` MUST report micro-polygons unfixed, with `unit_b` and `reason`
  null (see `docs/reference/topo-detect.md`).
- `schema-join` and `schema-map` MUST NOT apply this rule, since they
  never modify geometry.

## No-erosion guard (`$lib/db/coverage.ts::checkNoErosion`)

Shared by `edge-extend` (whole-file) and `edge-match` (per-group).

- For every fid present in the pre-extension table, `checkNoErosion` MUST
  raise unless the post-extension geometry for that fid, buffered outward
  by `SNAP_TOLERANCE`, `ST_Covers` the pre-extension geometry. A fid
  missing from the post-extension table entirely MUST also raise.
- This check MUST be treated as a hard failure, not a warn-only report:
  unlike this app's other post-clean topology checks (see `docs/adr/0027`),
  an erosion here means real data loss, not a cosmetic topology defect.

## Overlap measurement (`$lib/db/overlap.ts`)

Shared by `edge-match` (input/overlay assignment), `change` (version-to-version
comparison), `code-update` (per-level classify and reparent), and
`schema-join` (join assignment). Its pairwise intersection (`intersectPairs`)
is also shared by assign-one, the clip engine (`edge-clip`, `edge-mosaic`, and `edge-match`'s
per-group clip) and the shared overlap check (`topo-detect`, `topo-clean`).

- Overlap measurement MUST compute exact geometric intersection
  (`ST_Intersection`) for every candidate pair.
- A pair whose exact intersection throws MUST be retried once as
  `ST_Intersection(ST_Snap(a, b, SNAP_TOLERANCE), b)`. A pair whose snapped
  intersection also throws MUST be retried once with both sides on
  `ST_ReducePrecision(geom, 1e-11)`. A pair that still throws MUST propagate
  the failure to the caller.
- Whenever any pair falls back, `intersectPairs` MUST log the number of
  snapped and gridded pairs to the console, labelled with its caller.
- In `computeOverlapPairs`, an intersection piece with area below the
  sliver threshold (~1cm²) MUST be discarded before it contributes to any
  pair's shared area. Assign-one MUST count any pair with shared area above
  zero.
- Area and ratio calculations (`coverage_a`, `coverage_b`, `iou`) MUST use
  an equal-area projection, not raw EPSG:4326 degree-area.

### Best-overlap plurality pick (`$lib/db/assignBestOverlap.ts`)

Shared by `edge-match` (input/overlay assignment), `code-update` (per-level
reparent), and `schema-join` (join assignment).

- `assignBestOverlap` MUST assign each input feature (`input_fid`) to the
  overlay feature (`overlay_fid`) it shares the largest overlap area with,
  breaking a tie by lowest overlay fid.
- An input feature with zero overlapping overlay features MUST be absent
  from the output table entirely, not assigned a null overlay.

## Code-based assignment override (`$lib/db/codeJoin.ts`)

Shared by `edge-match`, `edge-mosaic`, and `edge-clip` for overlay assignment.

- Callers MAY supply a `matchColumn` name (same column on both layers) or a
  `overlayMatchColumn`/`inputMatchColumn` pair (different names), mutually
  exclusive with each other. Supplying only one of the pair MUST raise.
- When supplied, an exact code join, restricted to `(input, overlay)` pairs
  that already spatially overlap, MUST win over the default
  spatial-majority-vote assignment wherever a code match exists, even when
  it disagrees with the spatial result. An input feature (or, for assign-one,
  a whole file) whose code has no overlapping-overlay match MUST fall back to
  the spatial result (see `docs/adr/0029`).
- The outcome MUST be recorded as `assignmentMethod: 'code' | 'spatial_fallback'`
  and `spatialAgrees: boolean | null` (`true`/`false` when the method is
  `'code'`, `null` when it's `'spatial_fallback'`).
- A disagreement or fallback MUST surface as an issues row: `kind='code-mismatch'`
  when the code match won but disagreed with the spatial result, or
  `kind='code-fallback'` when no code match existed, with `reason`
  `code join picked a different overlay feature than spatial majority` or
  `no matching code; fell back to spatial majority` respectively. `unitA`
  MUST hold the input feature's own fid, `overlayFid` the winning overlay
  feature's fid.
- Omitting both parameters MUST leave assignment behavior and output schema
  unchanged for existing callers.

## Hierarchical code format and retention (`$lib/db/code.ts`)

Shared by `code-create` (cold-start) and `code-update` (reconcile
against an already-coded OLD layer).

- A `CodeFormat` (`rootCode`, `delimiter`, `minWidth`) MUST be validated
  via `resolveCodeFormat`: `rootCode` non-empty, `delimiter` exactly one
  character, or empty when the caller allows no delimiter. No field has
  a default.
- `minWidth` MUST be one positive width (`3`), one positive width per
  numbered level, coarsest first (`2,2,4`), or `auto`, parsed by
  `parseMinWidth`. A width list MUST have exactly one entry per numbered
  level (`checkLevelCount`), else throw.
- `parseCode` MUST split on `delimiter`, or, with an empty delimiter,
  strip `rootCode` and cut each level's tail at that level's width,
  throwing when the code doesn't start with the root or can't be cut.
- `assignNewCodes` MUST rank rows per parent group by their given sort
  columns and format each as `parentCode || delimiter || lpad(tail,
  width, '0')`, starting above every integer the parent's direct
  children use in `existingCodes`. It MUST NOT reuse a raw source value
  as-is.
- Under `auto`, every new tail at a level MUST pad to the widest tail
  that level needs, `existingCodes` included.
- With an empty delimiter and a fixed width, when the next number doesn't
  fit the width, numbering MUST continue above the parent's highest used
  number below the top 10% of the range (`9 * 10 ** (width - 1)`), and
  MUST throw if it would reach that cutoff.
- With a delimiter, a parent whose child count exceeds `10 ** width - 1`
  MUST NOT have its lower-numbered children's codes repadded; the
  overflowing child's own tail width MUST grow instead
  (`GREATEST(width, LENGTH(tail))`).
- `detectCodeFormat` MUST infer `delimiter` as the single non-alphanumeric
  character common to every sampled code, `rootCode` as the shared first
  delimiter-split component, and `minWidth` as each component position's
  most common width (one width when every position agrees). Any field
  that can't be confidently inferred MUST throw rather than fall back to
  a literal.
- `detectUndelimitedFormat` MUST infer `rootCode` as level 1's leading
  non-digit run, shared by every code, and each level's width as the
  single length it adds to its parent's code, throwing otherwise.
- `rewriteChildCode` MUST reattach a code's own final component onto a
  new parent code, leaving the tail integer and sibling ranking
  untouched.
- `seedCodeFromNames` MUST fill a level's code column from its name
  column, and throw when the level has no name column.
  `checkUniqueNames` MUST throw when a name repeats under one parent.

## Opt-in schema fill (`$lib/db/fillCompose.ts`)

Shared by `edge-stitch`, `edge-mosaic` (via `edge-stitch`'s own call), and `edge-match` for an
optional post-processing pass over each tool's own final attribute table.

- Callers MUST supply `fillSchema` (boolean), and MAY additionally supply a
  `nameField`/`codeField` pair, each containing a `{n}` placeholder. Both
  MUST be given together or both omitted; supplying only one MUST raise.
- Supplying `nameField`/`codeField` without `fillSchema` enabled MUST raise.
- `fillSchema: false` (the default) MUST leave the tool's output
  byte-identical to a run with no schema-fill support at all.
- `fillSchema: true` MUST cascade admin-hierarchy column families down the
  tool's own final attribute table in place, using the same depth-pin
  algorithm as `schema-fill` (see `docs/reference/schema-fill.md`): a
  legitimate `NULL` at a row's own real depth MUST be left untouched, and a
  `NULL` at a deeper level MUST be filled from the nearest non-`NULL`
  shallower level. A pre-existing column matching the configured depth
  column name MUST raise before any fill runs.
- The `nameField`/`codeField` pair, when supplied, MUST select the explicit
  target-schema path; when omitted, level and family detection MUST fall
  back to `schema-map`'s structural level-detection engine.
