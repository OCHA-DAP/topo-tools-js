# 0010: clipToBoundary wraps ST_Intersection in ST_CollectionExtract

## Status

Accepted

## Context

Loading Edge Matcher's Burundi output into QGIS surfaced a feature QGIS
couldn't render as part of the polygon layer. Isolated to one group's
("Mabanda" zone) geometry: a `GEOMETRYCOLLECTION` of 38 parts — one real
polygon (the whole feature) plus 37 near-zero-area sliver polygons (areas
from `1e-15` down to `1e-24`, pure floating-point noise) and one zero-area
stray `POINT`.

Root cause: `clipToBoundary.ts`'s `ST_Intersection(a.geom, c.geom)` between
a group's extended geometry and its parent boundary — where the two edges
are supposed to touch exactly rather than cross — can return mixed-type
noise at near-tangent contact points instead of a clean polygonal result;
GEOS's overlay doesn't guarantee a pure-polygon result type for
boundary-touching cases the way it does for a proper crossing. Any consumer
expecting `POLYGON`/`MULTIPOLYGON` (QGIS included) breaks on the resulting
`GEOMETRYCOLLECTION`.

## Decision

Wrap the intersection result in `ST_CollectionExtract(geom, 3)` (keep only
polygonal parts). No area-threshold filtering was added to also drop the
harmless slivers — picking a cutoff would be exactly the kind of arbitrary
magic-number fix this project's precision conventions avoid, and the actual
reported defect (the type-breaking collection) is already fully resolved
without one.

## Consequences

Verified directly against the failing geometry: total area unchanged
(exact match before and after), only the zero-area stray point dropped,
output type now a clean `MULTIPOLYGON`. The remaining sliver polygons are
still present, geometrically valid, and harmless.
