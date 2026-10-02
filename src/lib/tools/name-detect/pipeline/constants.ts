// Ported from topo-tools-py's core/name_detect/_constants.py.

export const SEVERITY = {
  "blank-code": "error",
  "blank-name": "error",
  "placeholder-name": "error",
  "duplicate-name": "warn",
  "name-conflict": "error",
  "encoding-artifact": "error",
  "normalized-duplicate-name": "warn",
  "invisible-character": "warn",
  "unnormalized-unicode": "warn",
  whitespace: "warn",
  "case-outlier": "warn",
  "mixed-script": "warn",
  "code-in-name": "warn",
} as const;

export type NameIssueKind = keyof typeof SEVERITY;
export type Severity = (typeof SEVERITY)[NameIssueKind];

// Kinds checked one name at a time, so a column-wide hit can roll up into one row.
export const PER_NAME_KINDS: NameIssueKind[] = [
  "blank-name",
  "placeholder-name",
  "encoding-artifact",
  "invisible-character",
  "unnormalized-unicode",
  "whitespace",
  "mixed-script",
  "code-in-name",
];

// Kinds whose `suggested` value name-clean applies; every other kind stays open.
export const FIXED_KINDS: NameIssueKind[] = [
  "whitespace",
  "invisible-character",
  "unnormalized-unicode",
  "encoding-artifact",
];

export const PLACEHOLDER_TOKENS = ["n/a", "n_a", "n.a.", "null", "none", "unknown", "undefined"];

// A sibling name column is checked for blanks only when it is mostly filled.
export const SIBLING_FILLED_SHARE = 0.9;

// case-outlier needs this share of a column's cased names in mixed case, and
// one all-caps word this long or two this short, so acronyms are skipped.
export const MIXED_CASE_SHARE = 0.9;
export const CASE_LONG_WORD = 6;
export const CASE_SHORT_WORD = 3;

// code-in-name matches whole tokens of codes holding a letter and a digit.
export const CODE_IN_NAME_MIN_LENGTH = 3;

// A kind hitting more than this share of a column (and at least ROLLUP_MIN_ROWS
// names) is reported as one column-level row.
export const ROLLUP_SHARE = 0.5;
export const ROLLUP_MIN_ROWS = 5;

// UTF-8 bytes read as cp1252. Only the commonest leads, a C1 control or U+FFFD
// are flagged alone; any other lead needs a plausible repair.
const CONTINUATION = String.raw`[\x{80}-\x{BF}\x{152}\x{153}\x{160}\x{161}\x{178}\x{17D}\x{17E}\x{192}\x{2C6}\x{2DC}\x{2013}\x{2014}\x{2018}-\x{201E}\x{2020}-\x{2022}\x{2026}\x{2030}\x{2039}\x{203A}\x{20AC}\x{2122}]`;
export const MOJIBAKE_PATTERN =
  String.raw`[\x{C2}-\x{DF}]` +
  CONTINUATION +
  "|" +
  String.raw`[\x{E0}-\x{EF}]` +
  CONTINUATION +
  CONTINUATION;
export const STRONG_MOJIBAKE_PATTERN =
  String.raw`[\x{C2}\x{C3}]` +
  CONTINUATION +
  String.raw`|\x{E2}\x{20AC}|\x{EF}\x{BF}\x{BD}|[\x{80}-\x{9F}]`;
export const REPLACEMENT_CHARACTER = "\ufffd";
// A repair is kept only if it yields Latin letters, digits, spaces and common
// punctuation, never a symbol, another script or a detached combining mark.
export const IMPLAUSIBLE_REPAIR_PATTERN = String.raw`[^\x{20}-\x{7E}\x{A0}-\x{24F}\x{1E00}-\x{1EFF}\x{2018}-\x{201D}\x{2013}\x{2014}\x{20AC}]|[\x{A1}-\x{BF}\x{D7}\x{F7}]`;

// cp1252's 0x80-0x9F characters; every other code point below 256 is its own byte.
export const CP1252_SPECIALS: Array<[number, number]> = [
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
];

// Format characters except ZWNJ/ZWJ (needed in Persian and Indic scripts),
// control characters, and any space other than U+0020.
export const INVISIBLE_PATTERN = String.raw`[^\P{Cf}\x{200C}\x{200D}]|\p{Cc}`;
// Roman numerals are capitals by convention, so case-outlier ignores them.
export const ROMAN_NUMERAL_PATTERN = "^[IVXLCDM]+$";
export const ODD_SPACE_PATTERN = String.raw`[^\P{Zs} ]|[\t\n\r]`;

// Scripts whose letters look alike, so a word mixing them is a likely typo.
export const CONFUSABLE_SCRIPTS = ["Latin", "Cyrillic", "Greek"];
