// Ported from topo-tools-py's core.constants.is_noise_column (docs/adr/0068 there).

export const NOISE_COLUMNS = new Set([
  "objectid",
  "globalid",
  "fid",
  "shape_leng",
  "shape_length",
  "shape__length",
  "shape_area",
  "shape__area",
  "ogc_fid",
  "ogc_fid_orig",
  "fid_orig",
]);

const NOISE_SUFFIX_RE = /_(\d+)$/;
const DBF_FIELD_NAME_LIMIT = 10;

export function isNoiseColumn(name: string): boolean {
  const lowered = name.toLowerCase();
  if (NOISE_COLUMNS.has(lowered)) return true;
  const match = NOISE_SUFFIX_RE.exec(lowered);
  if (!match) return false;
  const base = lowered.slice(0, match.index);
  if (NOISE_COLUMNS.has(base)) return true;
  return (
    lowered.length === DBF_FIELD_NAME_LIMIT &&
    [...NOISE_COLUMNS].some((noise) => noise.startsWith(base))
  );
}

// fid/geom are this app's own internal columns, never candidate source data.
export const EXCLUDED_COLUMNS = new Set(["fid", "geom"]);

export const CODE_SHAPE_MAJORITY = 0.5;

// Confidence tier labels embedded in an unresolved mapping's note text.
export const NOTE_AMBIGUOUS = "ambiguous";
export const NOTE_SUPPLEMENTAL = "supplemental";
