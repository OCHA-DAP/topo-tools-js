# Topology Tools

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser-only suite of geospatial topology utilities. Each tool runs
entirely client-side via WebAssembly (DuckDB WASM + MapLibre GL) — no input
file or derived geometry ever leaves the browser.

| Tool                            | What it does                                                                                                                            | Docs                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Topology Cleaner** (`/topo-clean`) | Detects overlaps and gaps in a polygon coverage and cleans them via `ST_CoverageClean`.                                                 | [`docs/explanation/topo-clean.md`](docs/explanation/topo-clean.md)   |
| **Edge Extender** (`/edge-extend`)   | Extends polygon boundaries outward with a Voronoi diagram to close gaps with neighbors.                                                 | [`docs/explanation/edge-extend.md`](docs/explanation/edge-extend.md) |
| **Edge Matcher** (`/edge-match`)     | Assigns a fine polygon layer to its best-overlapping coarse boundary, then extends each group independently.                            | [`docs/explanation/edge-match.md`](docs/explanation/edge-match.md)   |
| **Changelog** (`/change`)       | Compares two versions of a polygon layer and classifies every unit as unchanged, renamed, modified, split, merged, created, or removed. | [`docs/explanation/change.md`](docs/explanation/change.md) |

## Development

```sh
npm install
npm run dev       # start dev server (localhost:4321)
npm run build     # production build
npm run preview   # preview production build
npm run check     # Astro + TypeScript type check
```

See [`CLAUDE.md`](CLAUDE.md) for architecture and the full documentation map.

## Supported formats

Loading: GeoJSON, GeoParquet, GeoPackage, Shapefile (as a `.zip`), FlatGeobuf,
KML, GML, GPX. Exporting: GeoParquet always, plus whichever GDAL drivers the
loaded build supports among GeoPackage, Shapefile, FlatGeobuf, KML, and GML.
`change`'s tabular changelog exports as CSV or GeoParquet.

## License

[MIT](LICENSE)
