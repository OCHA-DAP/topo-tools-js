# 0028: Mosaic's warn-only gate deliberately covers both overlaps and gaps

## Status

Accepted

## Context

[0027](0027-mosaic-hard-gate-relaxed-to-warn-only.md) mischaracterized
topo-tools-py's actual `mosaic` gate as one hard `check_valid_topology()`
check, relaxed wholesale to warn-only in this app. That's not what Python
does: `mosaic/_03_outputs.py` calls `check_valid_topology(conn, table)` with
its default `gap_maximum_width=SNAP_TOLERANCE`, which raises unconditionally
on any invalid edge/overlap (`check_invalid_edges` has no tolerance-based
softening), and separately raises only on a gap at or below the noise floor
(`check_gaps`, relaxed from zero-tolerance in
[topo-tools-py ADR-0035](../../../topo-tools-py/docs/adr/0035-match-mosaic-gap-gate-relaxed-to-noise-floor.md)).
A wider gap (e.g. a real enclosed-country hole reproduced from the parent
layer) gets an issues-report row and a log warning, not a raise. So Python's
gate is a split: overlaps always hard-fail, only the gap half is tolerant.

This app has no raising-gate precedent anywhere (`stitch`'s and Edge
Extender's own post-clean checks are both warn-only by design), and 0027's
decision to keep `mosaic` warn-only stands — re-confirmed when fixing this
mischaracterization, rather than introducing the codebase's first raising
gate as a side effect of a documentation correction. What 0028 corrects is
only the *description* of Python's behavior and makes explicit that JS's
choice applies to both halves, not just the one Python already relaxed.

## Decision

`mosaic` stays warn-only for both checks: a residual overlap or a leftover
gap of any width after its stitch pass is reported (`console.warn` plus the
issues-report row, via `runStitch`'s existing `hadResidualOverlaps` check and
the shared noise-floor gap check added in
[db/coverage.ts](../../src/lib/db/coverage.ts)) but never blocks export. This
is a wider relaxation than Python's (which still hard-fails on overlaps),
made deliberately: JS has no existing raising gate to be consistent with, and
introducing one for `mosaic` alone would make it the sole exception with
different failure semantics from every sibling tool.

## Consequences

A `mosaic` run always produces its stitched output once assign and clip
succeed, including the case Python would refuse to export (a genuine
residual overlap). This is a wider, not narrower, safety margin than Python's
for that one case; anyone relying on the issues report and console warnings
to catch the same defects Python's hard gate catches must actually check
them, since JS will not refuse to write output. If this codebase ever adds a
first raising gate (e.g. to `stitch`/`extend`/`match`), `mosaic`'s overlap
check should be revisited to match at the same time.
