# 0014: Topology Cleaner's precision-reduction retry fallback removed entirely

## Status

Accepted

## Context

Topology Cleaner had a last-resort retry on GEOS `TopologyException`:
`ST_ReducePrecision(geom, 1e-10)` applied to the *entire* input layer, at
four call sites (the main clean in `index.ts`, gap/overlap detection
retries in `issues.ts`, and the export-verification sweep in `verify.ts`).
Unlike Edge Extender/Edge Matcher's noding retry (see
[0001](0001-precision-retry-mitigates-wasm-noding-failures.md)), which only
ever reduces precision on algorithmically-*derived* geometry, Topology
Cleaner's retry reduced precision on `layer_01` itself — the real,
user-supplied input, and the same table that gets exported. Its blast
radius was every vertex in the coverage for a defect usually local to a
couple of features, and it silently rewrote the actual exported geometry
with no user-facing indication. The Python port has no equivalent — a GEOS
overlay failure there just raises.

## Decision

Remove the precision-reduction retry entirely from all four call sites. On
a GEOS overlay failure, Topology Cleaner now fails/degrades the same way
the Python port does (gap/overlap detection degrades to an empty,
`failedKinds`-flagged table per kind; the main clean surfaces the error)
instead of silently substituting globally-snapped geometry for real input.

## Consequences

A GEOS overlay failure in Topology Cleaner is now visible (a failed-detection
flag or a thrown error) rather than masked by a silent, whole-coverage
precision downgrade. This is a deliberate divergence from Edge
Extender/Edge Matcher's own retry strategy — the two are not inconsistent:
Edge Extender/Edge Matcher's retry never touches real input geometry (only
algorithmically-derived Voronoi/clip output), so its blast radius is bounded
in a way Topology Cleaner's whole-input retry never was.
