# docs/reference/

Plain-English, verifiable behavior contracts for each tool, using RFC 2119
keywords:

- **MUST** / **MUST NOT**: required; a violation is a bug.
- **SHOULD** / **SHOULD NOT**: expected default behavior.
- **MAY**: explicitly allowed, not required.

`docs/reference/` states *what* each tool currently does, verified directly
against source. It does not explain *why* (rationale, rejected alternatives,
and benchmark data live in `docs/explanation/`).

One file per tool (`clean.md`, `extend.md`, `match.md`, `change.md`). A rule
identical across more than one tool goes in `shared.md`, referenced by name
instead of repeated in each tool's file.
