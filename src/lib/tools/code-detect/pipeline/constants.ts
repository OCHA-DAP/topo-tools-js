// Ported from topo-tools-py's core/code_detect/_constants.py.

export const SEVERITY = {
  "blank-code": "error",
  "name-conflict": "error",
  "duplicate-code": "error",
  "prefix-mismatch": "error",
  "split-unit": "warn",
  "format-outlier": "warn",
  "format-undetected": "warn",
} as const;

export type CodeIssueKind = keyof typeof SEVERITY;
export type Severity = (typeof SEVERITY)[CodeIssueKind];

// prefix-mismatch and format-outlier need this share of a level's codes to
// follow the rule, and at least FORMAT_MIN_CODES codes, before flagging the rest.
export const PREFIX_SHARE = 0.9;
export const SHAPE_SHARE = 0.9;
export const FORMAT_MIN_CODES = 10;
