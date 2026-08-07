# 0009: Loader renames a colliding OGC_FID property before registration

## Status

Accepted

## Context

Feeding Edge Matcher's own GeoJSON output back into Topology Cleaner failed
immediately with `Binder Error: table "st_read" has duplicate column name
"OGC_FID"`, before any pipeline logic ran — even on `SELECT COUNT(*)` or a
positional `SELECT #1`, so there was no SQL-side workaround once the file
was registered.

Root cause: DuckDB's `ST_Read` always adds its own FID column hardcoded to
the name `OGC_FID` (confirmed empirically; no `st_read` parameter suppresses
it). The Burundi source shapefiles' attribute table already had a real
property literally named `OGC_FID` — a common artifact of data that passed
through a prior `ogr2ogr`/GDAL export, since `OGC_FID` is GDAL's own default
FID field name — and that property survived Edge Matcher's attribute join
into its final export, so re-reading that export collided with `ST_Read`'s
synthetic column of the same name.

## Decision

For `.geojson`/`.geojsonl` inputs specifically (plain JSON, cheap to
parse/rewrite losslessly, unlike the binary/XML formats also supported):
scan every feature's `properties` for a key literally named `OGC_FID`
before registering the file buffer with DuckDB, and rename it to
`OGC_FID_orig` if present (`renameCollidingOgcFid`, `src/lib/db/loader.ts`).

## Consequences

Verified directly against the failing file natively: `DESCRIBE`/`SELECT *`
on the renamed file now bind cleanly, with `OGC_FID_orig` preserving the
original value and `OGC_FID` unambiguously DuckDB's own FID. The same
collision risk exists in principle for GPKG/SHP/KML/GML/GPX (DBF's 10-char
field limit even accommodates `OGC_FID` exactly), but those binary/XML
formats aren't cheaply patchable at the file-buffer level the way JSON is,
and no repro exists yet for those formats — not fixed there.
