import type { ExpressionSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

// ColorBrewer Set3 without its grey, light enough for dark lines on top.
const GROUP_PALETTE = [
  "#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462",
  "#b3de69", "#fccde5", "#bc80bd", "#ccebc5", "#ffed6f",
];

export const GROUP_COLOR = "__group_color";
export const GROUP_FILL_OPACITY = 0.6;

const SEP = "\u0000";

function keyOf(p: Record<string, unknown> | null, keyColumns: string[]): string {
  return keyColumns.map((c) => String(p?.[c] ?? "")).join(SEP);
}

// Each distinct `keyColumns` value, in sorted order, mapped to its palette color.
function groupColors(features: Feature[], keyColumns: string[]): Map<string, string> {
  const keys = [...new Set(features.map((f) => keyOf(f.properties, keyColumns)))].sort();
  return new Map(keys.map((k, i) => [k, GROUP_PALETTE[i % GROUP_PALETTE.length]]));
}

// Tags each feature with a fill color shared by every unit with the same values in `keyColumns`.
export function colorByGroup(geojson: string, keyColumns: string[]): FeatureCollection {
  const fc = JSON.parse(geojson) as FeatureCollection;
  const colors = groupColors(fc.features, keyColumns);
  for (const f of fc.features) {
    f.properties = { ...f.properties, [GROUP_COLOR]: colors.get(keyOf(f.properties, keyColumns))! };
  }
  return fc;
}

// The same colors as a paint expression, so a recolor leaves the source data alone.
export function groupFillExpression(
  features: Feature[],
  keyColumns: string[],
): ExpressionSpecification | string {
  if (keyColumns.length === 0) return GROUP_PALETTE[0];
  const key: unknown[] = ["concat"];
  keyColumns.forEach((c, i) => {
    if (i > 0) key.push(SEP);
    key.push(["coalesce", ["to-string", ["get", c]], ""]);
  });
  const pairs = [...groupColors(features, keyColumns)].flat();
  return ["match", key, ...pairs, GROUP_PALETTE[0]] as unknown as ExpressionSpecification;
}
