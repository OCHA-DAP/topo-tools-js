# Package

`package` runs `package-polygons`, `package-points`, and `package-lines`
against one loaded layer in a single call, for the common case of wanting
the full cartographic bundle at once, mirroring this app's `edge-mosaic`
composite pattern. Ported from topo-tools-py's
`package`.

## Pipeline

`pipeline/index.ts`'s `runPackage` loads the layer once, then calls
`runPackagePolygons`, `runPackagePoints`, and `runPackageLines` against
that same connection. No table names collide between the three
sub-pipelines (`pp_*`/`pkpt_*`/`pl_*` prefixes), so they run unmodified,
back to back, with no namespacing workaround needed.

## UI

`App.svelte` draws the package on one map (`PackageMap.svelte`), either
polygons one level at a time or lines with point labels, and offers a
single download: the whole package (every polygon level, points and
lines) as one zip.
