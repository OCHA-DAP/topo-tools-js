# 0047: Code Refactor is renamed Code Create

## Status

Accepted. Ports topo-tools-py ADR 0124 (topo-tools-py #161).

## Context

Choosing between the two code tools comes down to one question: is there
a previous release to carry codes from? "Code Refactor" didn't say that
it creates codes from scratch, and "refactor" reads as a
code-maintenance term.

## Decision

The tool is Code Create at `/code-create` (`src/lib/tools/code-create`,
`runCodeCreate`, export sources `code_create`/`code_create_issues`),
with no redirect from `/code-refactor`. Code Update keeps its name.

## Consequences

Links to `/code-refactor` return a 404. Earlier ADRs keep the name Code
Refactor.
