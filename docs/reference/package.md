# package

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention.

## Behavior

- `package` MUST call `package-polygons`, `package-points`, and
  `package-lines` against the same loaded layer and the same target
  schema (or the same auto-detection, when omitted), on one shared
  connection.
- `package` MUST NOT expose a per-sub-tool step option; each sub-tool
  runs its own full pipeline.

## Configuration

- `package` MUST process exactly one input file per run.
- `nameField`/`codeField`, when supplied, MUST be passed through
  unchanged to all three sub-calls.
