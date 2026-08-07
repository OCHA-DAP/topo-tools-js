# Run an at-scale test against the portolan catalog

Use the portolan catalog (see `CLAUDE.md`'s Test Datasets section for its
location and the read-only hard rule) when you need to exercise a tool at
real multi-thousand-feature scale, or test `change` against a genuine
old/new version pair.

## Layout

STAC-like: `{iso3}/{latest,vNN}/{adm0..adm3,lines,points}/{original,
extended,matched}.parquet`. Distinct `vNN` dirs are always genuinely
different content; `latest` is whichever `vNN` is newest.

## Picking a file (`clean` / `extend` / `match`)

Any single `{iso3}/{vNN}/{adm_level}/original.parquet` works — drop it
directly onto the tool's DropZone (`clean`/`extend`) or onto its child/parent
slot (`match`; pick two different admin levels of the same country, e.g.
adm3 into adm2). Never write, export, or download a result back into
`portolan/` — save downloads to a different folder.

## Picking an old/new pair (`change`)

1. Browse the country's catalog (local path, or fetch `./{iso3}/catalog.json`
   from the STAC root) and list its `vNN` dirs.
2. Not every country/admin-level has 2+ versions yet — confirm both `vNN`s
   you want to compare actually exist before dropping them into `change`.
3. Drop the older version as Version A and the newer as Version B.

## Testing at real-browser scale

Headless Playwright (`playwright-cli`) has a lower memory ceiling than a real
browser tab — a large file (100+ MB) that hard-crashes the headless tab on
drop may load fine in a real browser. Treat local headless testing as capped
at roughly 100-150 MB files; verify anything bigger in a real browser
instead (e.g. the deployed GitHub Pages build).

See [`docs/explanation/performance.md`](../explanation/performance.md#known-good-baselines-at-real-scale)
for confirmed clean runs at real scale, and
[`docs/adr/0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md)
for the known WASM OOM ceiling.
