# Package

`package` runs `package-polygons`, `package-points`, and `package-lines`
against one loaded layer in a single call, for the common case of wanting
the full cartographic bundle at once, mirroring this app's
`schema-crosswalk` composite pattern. Ported from topo-tools-py's
`package`.

## Pipeline

`pipeline/index.ts`'s `runPackage` loads the layer once, then calls
`runPackagePolygons`, `runPackagePoints`, and `runPackageLines` against
that same connection. No table names collide between the three
sub-pipelines (`pp_*`/`pkpt_*`/`pl_*` prefixes), so they run unmodified,
back to back, with no namespacing workaround needed.

## UI

`App.svelte` shows three sections (Polygons, Points, Lines), each with its
own summary line and `DownloadMenu`(s), and a single shared map with a
selector to switch between the polygon level currently in view, the
combined points layer, or the combined lines layer.
