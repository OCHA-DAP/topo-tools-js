# 0024: Clean's default gap-fill mode demoted from shape-based to noise-floor-only

## Status

Accepted

## Context

A line-by-line comparison against the sister Python port (`topo-tools-py`)
found its default gap-fill behavior had changed since this UI's Auto/All
modes were built: Python's default (reached by omitting its CLI flag
entirely — the literal string `"auto"` now raises `ValueError`) fills a gap
only when its width is at or below `SNAP_TOLERANCE`, an unconditionally safe
noise-floor fill regardless of shape. The old shape-based logic (fill any
gap whose Polsby-Popper compactness is ≤ 0.3) still exists in Python but is
renamed `auto` → `thin` and is no longer default (ADR-0033/0034 there): a
non-thin gap narrower than the widest thin gap could get swept in too,
judged too aggressive for an unattended default.

Python's `all` mode also changed independently: it now passes a fixed
`GAP_MAXIMUM_WIDTH_ALL_DEG = 360.0` sentinel, guaranteed to exceed any real
gap by construction, rather than computing "twice the widest detected gap."

This app's `topology-cleaner` tool still defaulted to the old shape-based
mode (named `auto` here too) and computed `all`'s fill width from the widest
detected gap.

## Decision

Add a fourth mode, `minimal` (`resolveGapFillWidths`'s `minimalFillM`):
fills a gap only when its width is ≤ `SNAP_TOLERANCE`, at exactly that
width. This is now the UI's default, replacing the old shape-based mode,
which is renamed `auto` → `thin` (unchanged logic) to match Python's naming.

`all` mode's actual fill width is now the fixed `GAP_MAXIMUM_WIDTH_ALL_DEG`
sentinel (`pipeline/units.ts`), applied directly via `recleanOnly`'s new
`allGaps` option, bypassing the meters→degrees slider conversion entirely.
The old "twice the widest detected gap, rounded to a nice number" formula is
kept under a new name, `sliderCeilingM` — it now only sizes the Manual
slider's ceiling and All mode's display text, decoupled from what actually
gets filled.

## Consequences

A dataset with only non-thin (non-sliver-shaped) gaps wider than
`SNAP_TOLERANCE` now cleans to a fully unfilled default output (Minimal
mode fills nothing), where it previously auto-filled under the old
shape-based default — a real behavior change for any such file, matching
Python. Thin mode remains available for users who want the old default's
sliver-only behavior. All mode's actual fill width no longer depends on
first measuring the widest detected gap, matching Python exactly; its
displayed "filling gaps up to X" estimate is now illustrative only; the
"every detected gap is filled" statement immediately below it remains the
authoritative claim.
