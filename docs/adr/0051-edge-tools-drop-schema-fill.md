# 0051: Edge tools drop the opt-in schema fill

## Status

Accepted. Diverges from topo-tools-py's `--fill-schema` on `edge-match`,
`edge-mosaic` and `edge-stitch` (topo-tools-py #22).

## Context

Edge Matcher, Mosaic and Stitch each carried a "Schema fill" section (a
checkbox, name and code templates, and a depth column) that ran
`schema-fill`'s cascade over the result before export. Schema Fill is
also its own tool and its own step on the home page. The extra section
made the edge tools' sidebars harder for new users to read.

## Decision

Remove schema fill from the three edge tools, along with their `fill`,
`name`, `code` and `depth` URL parameters and `$lib/db/fillCompose.ts`.
Users run Schema Fill as a separate step on the edge tool's output.

## Consequences

The JS edge tools have no equivalent of py's `--fill-schema`. Links that
carry `fill=true` still load, and the parameter is ignored. Cascading
hierarchy columns takes a second tool run in the browser.
