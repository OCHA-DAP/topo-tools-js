# CLAUDE.md

## Verification Over Recall

- Never rely on remembered knowledge for libraries, APIs, or frameworks —
  check installed versions and docs before writing code or making claims
- If you lack verified information, acknowledge uncertainty and investigate
  first rather than speculate

## Code Reuse

When adding a feature that requires logic that already exists elsewhere in the codebase, extract it into a shared module — don't copy it. Duplication is not a "minimal change"; it creates two places to maintain identical behaviour. The rule against premature abstraction applies to inventing new layers of indirection for hypothetical future needs, not to consolidating code that is already proven and used in multiple places.

## Collaboration Style

- Be objective, not agreeable — act as a partner, not a sycophant
- Push back when you disagree, flag tradeoffs honestly, don't sugarcoat problems
- Keep explanations brief and to the point
- Accuracy over speed

## Solution Choice

- Optimise for the best long-term answer, not the smallest delta from the
  current state. "Minimal change" is expedient, not principled — don't default
  to it. If you're proposing it for scope reasons, say so explicitly.
- When two clean endpoints exist (all-A or all-B), lead with the better one.
  Don't propose hybrids that split the difference unless the hybrid is
  genuinely better than both endpoints — mixed states usually carry the
  costs of both options without the full benefits of either.
- When recommending an approach, name the endpoint you'd actually pick and
  why, before listing alternatives.

## Documentation Structure

`docs/` follows Diátaxis: `docs/reference/` (RFC-2119 MUST/SHOULD/MAY behavior
contracts, no rationale), `docs/explanation/` (current-state rationale,
squashed/rewritten as understanding evolves), `docs/how-to/` (task-oriented
guides), `docs/tutorials/` (not yet written). `docs/adr/` holds immutable,
one-decision-per-file Architecture Decision Records (Nygard format) — see
`docs/adr/README.md`.

## Commands

```bash
npm run dev       # Start dev server (localhost:4321)
npm run build     # Production build
npm run preview   # Preview production build
npm run check     # Astro + TypeScript type check
```

## UI Verification

**Always verify UI changes in a real browser before reporting them done.** Type-checking and build success do not prove that a page renders, that an island hydrates, or that user flows work. Use `playwright-cli` (installed at `/opt/homebrew/bin/playwright-cli`) — a terminal wrapper around the Playwright MCP server, drivable from Bash.

Minimal flow:

```bash
npm run dev > /tmp/dev.log 2>&1 &      # background dev server
sleep 4 && grep -E "Local" /tmp/dev.log # find the port (may not be 4321 if busy)
playwright-cli open http://localhost:<port>/
playwright-cli snapshot                  # accessibility-tree snapshot of current page
playwright-cli eval "() => ({ ... })"    # arbitrary JS in page context
playwright-cli click <ref>               # ref comes from snapshot
playwright-cli dialog-accept             # or dialog-dismiss for window.confirm()
playwright-cli close                     # always close at the end
```

Notes:

- `playwright-cli snapshot` writes a YAML accessibility tree to `.playwright-cli/page-*.yml`. The tree includes element `ref` IDs (e.g. `ref=e9`) you pass to `click`/`hover`/`fill`. Trust `eval` output over older snapshot files — snapshots can be stale relative to the live DOM.
- `playwright-cli` uses one persistent browser per session. Use `attach`/`detach` only if you need to share a browser across processes; for our verification flows, `open` + `close` is enough.
- Do NOT write standalone `.spec.ts` files for this — drive Playwright from Bash via `playwright-cli`. (Reason: the project does not have a Playwright test runner configured, and per-test setup duplicates the dev-server lifecycle.)
- For PWA / offline behaviour, `caches.keys()`, `navigator.serviceWorker.getRegistrations()`, and `localStorage` are all reachable from `eval` for direct state inspection.

## Architecture

**Topology Tools** is a browser-only suite of geospatial topology utilities. Each tool runs client-side via WebAssembly, and no data leaves the browser. The root `/` is a landing page that lists tools, and `/intro` is the CNG Forum 2026 talk (`/talk` redirects to it), doubling as an introduction (slide text in `src/lib/talk/{intro,outro}.md`, demo slides embed each landing-page step's main tool that has a `tools.ts` `demo` entry, and the slide holding an `<!-- explorer -->` comment cycles a map through the views in `src/lib/talk/explorer.ts`, drawn from topo-tools-data's combined `sources/sources_adm1.pmtiles` on source.coop). `/docs/` is the Python & CLI user docs, rendered by Starlight from `topo-tools-py/docs/pages`, which `scripts/sync-py-docs.mjs` symlinks into `src/content/docs/docs` (`PY_DOCS_DIR` overrides the sibling-checkout default); the HDX theme for it lives in `src/styles/starlight-hdx.css` and `src/lib/components/starlight/`. The deploy also publishes the Claude Code plugin's `marketplace.json` and zip from `topo-tools-py/plugins`. Twenty-two tools ship today: **Topology Cleaner** at `/topo-clean`, **Edge Extender** at `/edge-extend`, **Changelog** at `/change`, **Edge Matcher** at `/edge-match`, **Stitch** at `/edge-stitch`, **Detect** at `/topo-detect`, **Clip** at `/edge-clip`, **Mosaic** at `/edge-mosaic`, **Package** at `/package`, **Package Polygons** at `/package-polygons`, **Package Points** at `/package-points`, **Package Lines** at `/package-lines`, **Schema Map** at `/schema-map`, **Schema Join** at `/schema-join`, **Schema Fill** at `/schema-fill`, **Schema Detect** at `/schema-detect`, **Code Create** at `/code-create`, **Code Update** at `/code-update`, **Code Detect** at `/code-detect`, **Name Detect** at `/name-detect`, **Name Clean** at `/name-clean` (one shared app, py's `docs/dev/reference/5-names/` is its spec), and **Validate** at `/validate` (runs schema-, topo-, code- and name-detect and summarizes them; the three detect tools and Validate share `src/lib/components/CheckApp.svelte`); see `docs/explanation/{topo-clean,edge-extend,change,edge-match,edge-stitch,topo-detect,edge-clip,edge-mosaic,package,package-polygons,package-points,package-lines,schema-map,schema-refactor,schema-join,schema-fill,code,code-create,code-update}.md` for what each does and how, and `docs/reference/{topo-clean,edge-extend,change,edge-match,edge-stitch,topo-detect,edge-clip,edge-mosaic,package,package-polygons,package-points,package-lines,schema-map,schema-refactor,schema-join,schema-fill,code-create,code-update}.md` for their behavior contracts.

**Stack:** Astro 7 (static site) + Starlight (`/docs/`) + Svelte 5 (interactive islands) + DuckDB WASM (spatial SQL engine) + MapLibre GL (map rendering)

### Key design decisions

- All geospatial logic is SQL, run inside DuckDB's spatial extension, not JavaScript. See `docs/explanation/edge-extend.md` for the 5-stage Voronoi pipeline.
- DuckDB WASM runs single-threaded with no COEP/COOP — see `docs/explanation/performance.md` for the memory model this implies and why COEP stays off.
- **Tool layout convention:** each tool lives at `src/lib/tools/<slug>/` (its `App.svelte` + a `pipeline/` directory if it has one) and has a route at `src/pages/<slug>.astro`. Shared infrastructure stays in `src/lib/db/` (DuckDB singleton + loader + export, plus `assignOne.ts`/`clipEngine.ts`/`clipTiling.ts` — assign-one and clip logic shared between Clip and Mosaic) and `src/lib/components/` (DropZone, InputStep, MapView, IssueMapView, MapPopup, DownloadMenu, PrivacyNote, OfflineToggle, ToolCard, CheckApp, IssueTable). Adding a tool = new folder under `tools/`, new entry in `src/lib/tools.ts`, new page, optionally an icon under `public/icons/tools/`. No infrastructure changes. Sidebar order: inputs (`<InputStep>`, folded once a result arrives in multi-input tools), settings, `<AdvancedOptions>` (always starts closed), status/errors, results, downloads, `<PrivacyNote>`. Every `<DropZone>` takes a `urlParam` (`url`, `old`/`new`, `input`/`join`, `input`/`overlay`, `crosswalk`), the query-string key for its URL input.
- Svelte 5 runes (`$state()`, `$effect()`, `untrack()`) — not legacy Svelte reactivity.
- Path alias `$lib` resolves to `src/lib/` (Vite alias in `astro.config.mjs` and the `paths` map in `tsconfig.json`).

## Reference Docs

- `docs/reference/` — behavior contracts per tool (`shared.md` for common settings/formats/gates)
- `docs/explanation/topo-clean.md` — defect detection, `ST_CoverageClean` semantics, gap-fill modes
- `docs/explanation/edge-extend.md` — Voronoi-extension algorithm, stage-by-stage detail, point-spacing derivation
- `docs/explanation/edge-match.md` — assignment algorithm, per-group extension, cross-group seams
- `docs/explanation/change.md` — overlap/classification algorithm, union-find, output schema
- `docs/explanation/edge-stitch.md` — whole-table CoverageClean seam-closing pass, gap-only issues report
- `docs/explanation/topo-detect.md` — read-only gap/overlap scan, shared with Topology Cleaner's own detection stage
- `docs/explanation/edge-clip.md` — assign-one majority vote, per-parent clip, single-winner-parent scope in this app
- `docs/explanation/edge-mosaic.md` — thin assign-one -> clip -> stitch orchestrator, no re-extension
- `docs/explanation/package.md`: thin package-polygons/points/lines orchestrator, no table-name collisions
- `docs/explanation/package-polygons.md`: per-level group-by dissolve, auto column keep/sum/drop, gap-only issues report
- `docs/explanation/package-points.md`: one representative point per level, generalizable-columns gate
- `docs/explanation/package-lines.md`: shared/exterior boundary extraction, coarsest-divergence classification
- `docs/explanation/schema-map.md`: one page over infer, in-table edit, and apply, geometry drawn once; structural admin-hierarchy inference, no name/vocabulary matching
- `docs/explanation/schema-refactor.md`: Schema Map's apply step, crosswalk-driven column rename/drop, no geometry touch
- `docs/explanation/schema-join.md`: QGIS-style join by location (largest overlap), copies join-layer hierarchy columns, conflicting values as numbered siblings
- `docs/explanation/schema-fill.md`: cascades admin-hierarchy column families down, stamps a pre-fill depth column, attribute-only
- `docs/explanation/code.md`: shared hierarchical-code primitive, cascade/rewrite/detect-format functions
- `docs/explanation/code-create.md`: chained per-level cascade cold-starting a code from root (replace, embed or copy source codes), overflow issues report
- `docs/explanation/code-update.md`: per-level dissolve/classify/reparent/assign loop, retention policy over `change`'s relationship classes
- `docs/explanation/performance.md` — WASM memory model, SPATIAL_JOIN behaviour, connection settings, pipeline phase memory profile
- `.claude/skills/at-scale-testing/` (portolan catalog layout, picking a file or old/new pair for a real-scale test)
- `docs/adr/README.md` — how to decide whether a fact belongs in an ADR vs. `docs/explanation/` vs. this file
- `docs/adr/` — immutable decision records behind the WASM-GEOS robustness workarounds referenced above

## Test Datasets

A full portolan catalog (real, large-scale admin boundary data, multiple
countries and admin levels, some with multiple historical versions) is
available for at-scale/real-data stress testing in the browser (drop a file
in via the tool's DropZone):

- **Local copy**: `/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan`
- **Live/canonical source**: [source.coop/hdx/cod-ab](https://source.coop/hdx/cod-ab),
  STAC root catalog at `https://data.source.coop/hdx/cod-ab/catalog.json`
  (`id: portolan`; per-country `child` links, e.g. `./chl/catalog.json`)

**HARD RULE — the portolan catalog is read-only.** Never write, modify,
move, rename, or delete anything under
`/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan` (or its
canonical source.coop source). Only ever read from it — drop copies of its
files into tool DropZones, never point a write/export/cleanup operation at
it, and never run shell commands there beyond read-only listing/inspection.

See the `at-scale-testing` skill for the STAC layout and how to pick a
file (or an old/new comparison pair, for `change`) from the catalog.
