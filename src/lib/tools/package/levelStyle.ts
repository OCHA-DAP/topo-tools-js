import type { ExpressionSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

export interface LevelStyle {
  depth: number;
  color: string;
  width: number;
  // Dash pattern in line widths; null draws solid.
  dash: number[] | null;
  textSize: number;
  bold: boolean;
}

// HDX neutral-9 to neutral-7, dark enough to read over any group fill.
const LEVEL_COLORS = ["#1f2324", "#3f4748", "#5e6a6b"];

// ColorBrewer Set3 without its grey, light enough for dark lines on top.
const GROUP_PALETTE = [
  "#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462",
  "#b3de69", "#fccde5", "#bc80bd", "#ccebc5", "#ffed6f",
];

export const GROUP_COLOR = "__group_color";

// Coarsest depth draws darkest, widest and solid; the finest draws lightest and dotted.
export function levelStyles(depths: number[]): LevelStyle[] {
  const sorted = [...new Set(depths)].sort((a, b) => a - b);
  const last = Math.max(sorted.length - 1, 1);
  return sorted.map((depth, i) => {
    const t = i / last;
    return {
      depth,
      color: LEVEL_COLORS[Math.round(t * (LEVEL_COLORS.length - 1))],
      width: 3 - 1.5 * t,
      dash: t <= 0.5 ? null : t < 1 ? [3, 2] : [0.1, 2],
      textSize: 14 - 3 * t,
      bold: t < 0.5,
    };
  });
}

// A `match` on the depth column picking each level's value, the finest level's as fallback.
export function byDepth(
  styles: LevelStyle[],
  column: string,
  pick: (s: LevelStyle) => unknown,
): ExpressionSpecification {
  const fallback = pick(styles[styles.length - 1]);
  return [
    "match",
    ["get", column],
    ...styles.flatMap((s) => [s.depth, pick(s)]),
    fallback,
  ] as unknown as ExpressionSpecification;
}

// Tags each feature with a fill color shared by every unit with the same values in `keyColumns`.
export function colorByGroup(geojson: string, keyColumns: string[]): FeatureCollection {
  const fc = JSON.parse(geojson) as FeatureCollection;
  const keyOf = (p: Record<string, unknown> | null) =>
    keyColumns.map((c) => String(p?.[c] ?? "")).join("\u0000");
  const keys = [...new Set(fc.features.map((f) => keyOf(f.properties)))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  for (const f of fc.features) {
    f.properties = {
      ...f.properties,
      [GROUP_COLOR]: GROUP_PALETTE[index.get(keyOf(f.properties))! % GROUP_PALETTE.length],
    };
  }
  return fc;
}
