# 0020: Auto-mode gap-fill width uses epsilon headroom, not "2x and round"

## Status

Accepted

## Context

Auto mode's gap-fill width was `niceNum(2 × widest qualifying gap width)` —
double the widest digitization-sliver gap's width, then rounded up to a
nice number (1/2/5 × 10^k). `ST_CoverageClean` has no concept of
"thinness," only width, so a `gap_maximum_width` far wider than the actual
widest sliver risks also filling a legitimately wide, non-thin gap that
Auto mode was never meant to touch (e.g. a 33m widest sliver rounding up to
a 100m fill width via `niceNum(66)`). The sister Python port went through
the same reasoning and, after real-data tuning, converged on a tight
epsilon-headroom factor instead — just enough to reliably clear
`ST_CoverageClean`'s internal `<=` width comparison
(`AUTO_GAP_WIDTH_EPSILON_FACTOR`, most recently widened from `1.001` to
`1.01`).

## Decision

Auto mode's fill width is now `widest qualifying gap width × 1.01`, with no
`niceNum` rounding. `All` mode is deliberately left unchanged
(`niceNum(2 × widest of all gaps)`): since `all` already means "fill every
detected gap regardless of shape," a looser bound changes no outcome there
(every gap still gets filled either way), and that value does double duty
sizing the Manual slider's max/step in the UI — a concern the Python port,
which has no slider, doesn't share.

## Consequences

Auto-mode cleans now pass a materially tighter `gap_maximum_width` to
`ST_CoverageClean` than before, reducing the chance of collateral-filling a
wider, non-thin gap. All/Manual mode behavior is unchanged.
