# 0026: `clip` scoped to a single assign-one group in this app

## Status

Accepted

## Context

topo-tools-py's `clip` accepts multiple children files in one CLI
invocation (an `output_paths` list), tags every loaded child row with a
`source_file` column, and runs `assign_one`'s majority vote independently
per source file — a country with several already-extended admin layers, one
file per layer, each voting for its own winner parent. It also supports an
optional `match_column` code-join override that replaces the geometric vote
with an attribute join, producing its own issues report.

This app's DropZone has no `source_file`-per-upload concept: multiple files
dropped into one zone are sidecar parts of one logical layer (e.g. a
Shapefile's `.shp`/`.dbf`/`.shx`), not independent voting groups (confirmed
against `src/lib/db/loader.ts`, which carries no per-file tagging). A
two-DropZone UI (children, parent) therefore has exactly one children
upload, hence exactly one majority-vote group and exactly one winner parent
per run, every time — structurally identical to how Python's own `mosaic`
already calls `assign_one` a single time per run. `match`'s existing JS
port doesn't implement Python's optional `match_column` code-join feature
either, so omitting it here keeps `clip` consistent with the same
already-established MUST/SHOULD-only JS parity boundary.

## Decision

`clip` in this app processes exactly one children file (one upload, one
majority-vote group, one winner parent) and one parent/clip file per run.
The multi-file batch mode, the `source_file` grouping it depends on, and
the `match_column` optional code-join/issues-report feature are out of
scope for the JS port.

## Consequences

`assign.ts`'s `assignOne` and `engine.ts`'s `clipEngine` need no per-source
group loop and no per-parent-fid loop — both act on the single winner
parent directly. This also drops Python's `prepare_parent_tiles` /
`use_cached_tiles` split entirely: with a single winner parent per run,
there is never a second parent fid whose tiles could be reused across
groups. If a future request needs multiple children files clipped against
independently voted parents in one run, that would require adding
per-upload grouping to the DropZone/loader layer first — a bigger change
than `clip` itself, and out of scope here.
