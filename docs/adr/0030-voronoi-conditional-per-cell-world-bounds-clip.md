# 0030: Voronoi exterior cells clipped to world bounds, conditionally, per cell

## Status

Accepted. Ports
[topo-tools-py ADR-0096](../../../topo-tools-py/docs/adr/0096-voronoi-conditional-per-cell-world-bounds-clip.md).

## Context

`edge-extend`'s Voronoi stage (`src/lib/tools/edge-extender/pipeline/voronoi.ts`)
builds one diagram from every boundary point in a file at once via
`ST_VoronoiDiagram`. A point on the outer edge of that point cloud has a
mathematically unbounded cell, which GEOS closes using an auto-sized
clipping envelope based on the point cloud's own extent, not any real-world
constraint. Over country-scale lon/lat point clouds, that auto-envelope can
overshoot valid WGS84 range for the outermost cells (topo-tools-py confirmed
this on real Chile and Indonesia adm2 data: `ymin=-99` for Chile,
`xmax=187` for Indonesia, both on peripheral fids).

Two approaches were tried and rejected upstream, and carry over here:

- Intersecting the raw diagram against a world-bounds rectangle before the
  per-cell `ST_Dump`/`UNNEST` (one `ST_Intersection` call on the whole
  `GEOMETRYCOLLECTION`) OOM'd on real-scale input: GEOS processing one
  collection with 100k+ parts as a single intersection operand is far more
  expensive than the equivalent per-row calls.
- Intersecting every dumped cell against the world-bounds rectangle
  unconditionally (cheap, no OOM) perturbs even well-within-bounds cells:
  running a small interior cell through `ST_Intersection` against an operand
  spanning -180..180/-90..90 re-nodes its vertices against both operands'
  combined precision, breaking exact-match shared edges with untouched
  neighbor cells.

## Decision

Clip a cell only when its own bbox already exceeds `-180/-90/180/90`
(`ST_XMin`/`ST_XMax`/`ST_YMin`/`ST_YMax` checked per row, after the dump),
leaving every interior cell byte-identical to its pre-fix geometry.

## Consequences

A peripheral cell that does get clipped can still introduce
`SNAP_TOLERANCE`-scale noise against its interior neighbor's shared edge.
The pipeline's existing whole-layer clean pass (`stageMerge`'s
`gatedCoverageClean` call in `src/lib/tools/edge-extender/pipeline/index.ts`)
already absorbs this.
