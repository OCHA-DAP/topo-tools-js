# 0052: Match defaults to an auto mode that picks One or Several

## Status

Accepted. Supersedes the UI default in ADR-0041. Diverges from
topo-tools-py, whose `edge-match` keeps assign-one as its default.

## Context

ADR-0041 made assign-one Match's default to follow topo-tools-py, and
rejected choosing the mode from the data. py defaults to assign-one because
a CLI run gives no visual feedback, so a wrong automatic pick would go
unnoticed. In the browser the result is drawn on the map and the mode
switch sits next to it. A layer that spans many overlay features (NLD
admin2 into admin1) loses most of its features under assign-one until the
user finds the switch.

## Decision

Match takes a mode of `auto`, `one` or `several`, defaulting to `auto`, in
the `match` URL parameter. Auto runs assign-one's majority vote and
switches to per-feature when fewer than half the input features overlap the
winner. The switch marks the automatic pick ("Several (auto)"). Choosing
the other option overrides it and reruns, and "Pick automatically" returns
to auto.

## Consequences

NLD admin2 into admin1 (79 of 342 features overlap the winner) runs as
Several. A one-province file with a few offshore strays runs as One. The
same inputs can give different results in JS and py unless the py run
passes `--multi-parent`. Auto mode pays for the majority vote before a
per-feature run, which is small next to per-group extension.
