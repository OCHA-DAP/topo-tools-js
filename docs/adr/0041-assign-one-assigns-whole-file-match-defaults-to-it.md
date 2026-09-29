# 0041: assign-one assigns the whole file, and Match defaults to it

## Status

Accepted

## Context

`assignOne` (Clip, Mosaic) picked a majority-vote winner, then dropped every
input feature that did not overlap it as `unassigned`. Match assigned each
input feature to its largest-overlap overlay feature. topo-tools-py's
`assign_one` (its ADR 0082) assigns every input feature in a file to the
winner unconditionally, reports features whose clip comes out empty as
`clip-empty`, and `edge-match` defaults to assign-one with `--per-feature`
for the plurality mode. The two ports gave different outputs and issue
kinds from py on the same inputs (NLD admin2 into admin1: py 72 features and
263 `clip-empty` rows).

## Decision

Port py's contract. `assignOne` assigns every input feature to the winner
and returns a null winner, rather than throwing, when no overlay feature
gets a vote; Clip and Mosaic fail the run on a null winner. Features whose
clip is empty become `clip-empty` issue rows carrying their pre-clip
geometry, built by the shared `assignOneDropIssuesSql`. Match runs
`assignOne` by default and keeps plurality assignment behind a per-feature
option. The UI states the fitting mode in one line with a toggle, and when
features are clipped away in assign-one mode the warning offers a one-click
switch to per-feature, rather than choosing the mode from the data.

## Consequences

JS Match, Clip and Mosaic produce py's feature counts and issue kinds on the
same inputs. `unassigned` in Clip and Mosaic only arises when no overlay
feature wins. A Match user fitting a layer that spans several overlay
features gets most of it clipped away until they switch to per-feature;
the warning and its button carry that cost instead of a silent heuristic.
