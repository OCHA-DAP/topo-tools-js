# docs/explanation/

Current-state rationale: how each tool's algorithm/pipeline works and why,
for someone who wants the background behind current behavior, not just what
it is.

`docs/explanation/` describes the system as it stands today. It is
squashed/rewritten as understanding evolves — no investigation narrative. A
paragraph starting with "confirmed", "previously", "was misdiagnosed", or
"verified empirically" belongs in [`docs/adr/`](../adr/README.md) instead.

One file per tool (`clean.md`, `extend.md`, `match.md`, `change.md`), plus
`performance.md` for cross-tool WASM memory/performance behavior.
