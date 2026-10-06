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

// Ported from topo-tools-py's core/constants.py; clip-detached piece merge rule,
// see mergeDetachedParts in $lib/db/coverage.ts.
export const DETACHED_MERGE_MAX_RATIO = 0.01;
export const DETACHED_MAX_ORIGINAL_SHARE = 0.5;
export const DETACHED_MIN_NECK_RATIO = 0.1;

// Ported from topo-tools-py's core/constants.py; notch detection and closing,
// see $lib/db/notches.ts.
export const NOTCH_SPACING = 0.0002;
export const NOTCH_MIN_SCORE = 2;
export const NOTCH_MAX_GAP_RATIO = 1 / 10;
export const NOTCH_WINDOW_MARGIN = 0.002;
