export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  iconHref: string;
}

export const tools: Tool[] = [
  {
    slug: "clean",
    name: "Topology Cleaner",
    tagline:
      "Detect overlaps and gaps in a polygon coverage and clean them automatically, with an adjustable gap-width threshold.",
    iconHref: "/icons/tools/topology-cleaner.svg",
  },
  {
    slug: "extend",
    name: "Edge Extender",
    tagline:
      "Fill gaps between adjacent polygons by extending boundaries outward with Voronoi diagrams.",
    iconHref: "/icons/tools/edge-extender.svg",
  },
  {
    slug: "match",
    name: "Edge Matcher",
    tagline:
      "Match fine polygons to their best-overlapping coarse boundary — admin 4 into 3, admin 4 into 0, or any other pair — then extend each group to fit its boundary exactly.",
    iconHref: "/icons/tools/match.svg",
  },
  {
    slug: "change",
    name: "Changelog",
    tagline:
      "Compare two versions of a polygon layer and classify each unit as unchanged, modified, merged, split, created, or removed.",
    iconHref: "/icons/tools/polygon-changelog.svg",
  },
  {
    slug: "stitch",
    name: "Stitch",
    tagline:
      "Close seams in an already-tiled polygon layer with a single whole-table coverage-clean pass.",
    iconHref: "/icons/tools/stitch.svg",
  },
  {
    slug: "detect",
    name: "Detect",
    tagline:
      "Scan a polygon layer for gaps and overlaps and report them — a read-only inspection, not a fix.",
    iconHref: "/icons/tools/detect.svg",
  },
  {
    slug: "clip",
    name: "Clip",
    tagline:
      "Assign a children layer to its one best-overlapping parent unit by majority vote, then clip every child to that boundary.",
    iconHref: "/icons/tools/clip.svg",
  },
  {
    slug: "mosaic",
    name: "Mosaic",
    tagline:
      "Fit an already-extended children layer into a new parent boundary — assign, clip, and close seams in one pass, no re-extension.",
    iconHref: "/icons/tools/mosaic.svg",
  },
  {
    slug: "dissolve",
    name: "Dissolve",
    tagline:
      "Aggregate a polygon layer into a coarser one by grouping on attribute columns, unioning each group's geometry into a single feature.",
    iconHref: "/icons/tools/dissolve.svg",
  },
  {
    slug: "schema-crosswalk",
    name: "Schema Crosswalk",
    tagline:
      "Infer a polygon layer's admin hierarchy crosswalk and immediately apply it, producing both the crosswalk CSV and the renamed layer in one call.",
    iconHref: "/icons/tools/schema-crosswalk.svg",
  },
  {
    slug: "schema-map",
    name: "Schema Map",
    tagline:
      "Infer a polygon layer's admin hierarchy structurally, from cardinality and containment alone, and propose a crosswalk to a target schema for review.",
    iconHref: "/icons/tools/schema-map.svg",
  },
  {
    slug: "schema-refactor",
    name: "Schema Refactor",
    tagline:
      "Apply a crosswalk CSV, from Schema Map or hand-edited, to rename or drop a polygon layer's columns. Geometry passes through unchanged.",
    iconHref: "/icons/tools/schema-refactor.svg",
  },
];
