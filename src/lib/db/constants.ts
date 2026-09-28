// Snap/gap tolerance shared across tools, in decimal degrees (~1.1mm at the equator).
export const SNAP_TOLERANCE = 1e-8;

// Grid a union retries on when WASM GEOS throws a noding error that native GEOS doesn't.
export const NODING_FALLBACK_GRID = 1e-11;

// Ported from topo-tools-py's core/constants.py. Governs when/how an overlay feature
// boundary gets grid-subdivided before intersecting against it, shared by
// clip and mosaic — see $lib/db/clipTiling.ts.
export const CLIP_TILE_MIN_VERTICES = 5000;
export const CLIP_TILE_TARGET_VERTICES = 1350;
export const CLIP_TILE_MIN_CELL = 0.05;
export const CLIP_TILE_MAX_CELL = 5.0;
