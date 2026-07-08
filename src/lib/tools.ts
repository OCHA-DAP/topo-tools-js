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
];
