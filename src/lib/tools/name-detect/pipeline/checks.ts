import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  CASE_LONG_WORD,
  CASE_SHORT_WORD,
  CODE_IN_NAME_MIN_LENGTH,
  CONFUSABLE_SCRIPTS,
  INVISIBLE_PATTERN,
  MIXED_CASE_SHARE,
  MOJIBAKE_PATTERN,
  ODD_SPACE_PATTERN,
  PLACEHOLDER_TOKENS,
  REPLACEMENT_CHARACTER,
  ROMAN_NUMERAL_PATTERN,
  SIBLING_FILLED_SHARE,
  STRONG_MOJIBAKE_PATTERN,
  type NameIssueKind,
} from "./constants";
import { createNameMacros } from "./macros";

const COLUMNS =
  "kind VARCHAR, level INTEGER, name_column VARCHAR, code_a VARCHAR, " +
  "name_a VARCHAR, code_b VARCHAR, name_b VARCHAR, suggested VARCHAR, reason VARCHAR";

const coded = (source: string): string => `(SELECT * FROM ${source} WHERE code IS NOT NULL)`;

const named = (source: string): string =>
  `(SELECT * FROM ${coded(source)} WHERE name IS NOT NULL AND trim(name) <> '')`;

function perName(
  kind: NameIssueKind,
  source: string,
  where: string,
  reason: string,
  suggested = "NULL",
): string {
  return `--sql
    SELECT '${kind}', level, name_column, code, name, NULL, NULL, ${suggested}, ${reason}
    FROM ${named(source)} WHERE ${where}
  `;
}

// A sibling column (an alternate name) is checked only when mostly filled.
const blank = (source: string): string => `--sql
  WITH filled AS (
    SELECT level, name_column, avg((name IS NOT NULL AND trim(name) <> '')::INT) AS share
    FROM ${source} GROUP BY ALL
  )
  SELECT 'blank-name', t.level, t.name_column, t.code, t.name, NULL, NULL, NULL, 'no name'
  FROM ${coded(source)} t JOIN filled f USING (level, name_column)
  WHERE (t.name IS NULL
         OR trim(regexp_replace(t.name, '\\s|${INVISIBLE_PATTERN}', '', 'g')) = '')
    AND (t.name_index = 0 OR f.share >= ${SIBLING_FILLED_SHARE})
`;

const blankCode = (source: string): string => `--sql
  SELECT 'blank-code', level, code_column, NULL, NULL, NULL, NULL, NULL,
         printf('%d units under %s have no code: %s', count(*),
                coalesce(parent_code, 'the root'),
                coalesce(string_agg(DISTINCT name, ' / '), 'no name either'))
  FROM ${source} WHERE code IS NULL AND name_index = 0
  GROUP BY level, code_column, parent_code
`;

function placeholder(source: string): string {
  const tokens = PLACEHOLDER_TOKENS.map((t) => `'${t}'`).join(", ");
  return perName(
    "placeholder-name",
    source,
    `lower(trim(name)) IN (${tokens}) OR lower(trim(name)) = lower(code) ` +
      `OR NOT regexp_matches(name, '[\\p{L}\\p{N}]')`,
    "'a placeholder, not a name'",
  );
}

// SQL testing that every letter in column belongs to one of scripts.
function lettersIn(column: string, scripts: string[]): string {
  const allowed = scripts.map((s) => `\\p{${s}}`).join("");
  return `NOT regexp_matches(${column}, '[^\\P{L}${allowed}]')`;
}

// The same units matched in several language columns are reported once.
const FIRST_COLUMN_ONLY =
  "QUALIFY row_number() OVER (PARTITION BY level, codes ORDER BY name_index) = 1";

const duplicate = (source: string): string => `--sql
  SELECT 'duplicate-name', level, name_column, codes[1], name, codes[2], name,
         NULL, printf('%d units under %s share this name: %s',
                      len(codes), coalesce(parent_code, 'the root'),
                      array_to_string(codes, ', '))
  FROM (
    SELECT level, name_column, name_index, parent_code, name,
           list_sort(list(DISTINCT code)) AS codes
    FROM ${named(source)} GROUP BY ALL
  )
  WHERE len(codes) > 1
  ${FIRST_COLUMN_ONLY}
`;

// SQL dropping separators between letters, other punctuation to a space.
function squash(text: string): string {
  const other = "[^\\p{L}\\p{M}\\p{N}]+";
  const between = `([\\p{L}\\p{M}])${other}(\\p{L})`;
  const joined = `regexp_replace(${text}, '${between}', '\\1\\2', 'g')`;
  return `trim(regexp_replace(${joined}, '${other}', ' ', 'g'))`;
}

// Accents are folded only in Latin names and only against an unaccented
// spelling: elsewhere (Vietnamese tones, Burmese vowels) they change the name.
function normalizedDuplicate(source: string): string {
  const strict = squash("lower(nfc_normalize(name))");
  const folded = squash("lower(strip_accents(name))");
  const latin = lettersIn("name", ["Latin"]);
  return `--sql
    WITH n AS (
      SELECT *, ${strict} AS strict,
             CASE WHEN ${latin} THEN ${folded} ELSE ${strict} END AS norm
      FROM ${named(source)}
    )
    SELECT 'normalized-duplicate-name', level, name_column,
           units[1].code, units[1].name, units[2].code, units[2].name, NULL,
           printf('%d units under %s have names that differ only in case, '
                  'accents or punctuation: %s', len(codes),
                  coalesce(parent_code, 'the root'), array_to_string(names, ' / '))
    FROM (
      SELECT level, name_column, name_index, parent_code,
             list_sort(list(DISTINCT code)) AS codes,
             list_sort(list(DISTINCT name)) AS names,
             list_sort(list(DISTINCT {'code': code, 'name': name})) AS units,
             count(DISTINCT strict) = 1 OR bool_or(name = strip_accents(name))
               AS unaccented_match
      FROM n WHERE norm <> ''
      GROUP BY level, name_column, name_index, parent_code, norm
    )
    WHERE len(codes) > 1 AND len(names) > 1 AND unaccented_match
    ${FIRST_COLUMN_ONLY}
  `;
}

const conflict = (source: string): string => `--sql
  SELECT 'name-conflict', level, name_column, code, names[1], code, names[2],
         NULL, printf('code %s has %d names: %s', code, len(names),
                      array_to_string(names, ' / '))
  FROM (
    SELECT level, name_column, name_index, code, list_sort(list(DISTINCT name)) AS names
    FROM ${named(source)} WHERE code IS NOT NULL GROUP BY ALL
  )
  WHERE len(names) > 1
  QUALIFY row_number() OVER (PARTITION BY level, code ORDER BY name_index) = 1
`;

const encoding = (source: string): string =>
  perName(
    "encoding-artifact",
    source,
    `contains(name, '${REPLACEMENT_CHARACTER}') ` +
      `OR regexp_matches(name, '${STRONG_MOJIBAKE_PATTERN}') ` +
      `OR (regexp_matches(name, '${MOJIBAKE_PATTERN}') ` +
      "AND name_repair_mojibake(name) IS NOT NULL)",
    `CASE WHEN contains(name, '${REPLACEMENT_CHARACTER}') ` +
      "THEN 'contains U+FFFD, characters lost when the file was read' " +
      "WHEN name_repair_mojibake(name) IS NULL " +
      "THEN 'looks like text read with the wrong encoding, no safe repair' " +
      "ELSE 'text read with the wrong encoding' END",
    "name_repair_mojibake(name)",
  );

const invisible = (source: string): string =>
  perName(
    "invisible-character",
    source,
    `regexp_matches(name, '${INVISIBLE_PATTERN}|${ODD_SPACE_PATTERN}')`,
    "'contains invisible characters or non-standard spaces'",
    "name_clean(name)",
  );

const unnormalized = (source: string): string =>
  perName(
    "unnormalized-unicode",
    source,
    "length(nfc_normalize(name)) < length(name)",
    "'accents stored as separate characters (not NFC)'",
    "name_clean(name)",
  );

const whitespace = (source: string): string =>
  perName(
    "whitespace",
    source,
    "regexp_matches(name, '^ | $|  ')",
    "'leading, trailing or repeated spaces'",
    "name_clean(name)",
  );

// Only bicameral scripts: Georgian, for one, is stored as lower case letters.
function caseOutlier(source: string): string {
  const caps = `list_transform(list_filter(
    regexp_split_to_array(name, '[^\\p{L}]+'),
    w -> w = upper(w) AND w <> lower(w)
         AND NOT regexp_matches(w, '${ROMAN_NUMERAL_PATTERN}')), w -> length(w))`;
  return `--sql
    WITH c AS (
      SELECT *,
             regexp_matches(name, '\\p{Lu}') AS has_upper,
             regexp_matches(name, '\\p{Ll}') AS has_lower,
             ${caps} AS caps
      FROM ${named(source)} WHERE ${lettersIn("name", CONFUSABLE_SCRIPTS)}
    ), o AS (
      -- An acronym is neither mixed case nor an outlier.
      SELECT *, has_upper <> has_lower
                AND regexp_matches(name, '\\p{L}{${CASE_SHORT_WORD + 1}}')
                AND (NOT has_upper
                     OR list_max(caps) >= ${CASE_LONG_WORD}
                     OR len(list_filter(caps, n -> n >= ${CASE_SHORT_WORD})) >= 2)
                AS outlier
      FROM c
    ), share AS (
      SELECT level, name_column, avg((NOT outlier)::INT) AS mixed
      FROM o WHERE (has_upper AND has_lower) OR outlier GROUP BY ALL
    )
    SELECT 'case-outlier', level, name_column, code, name, NULL, NULL, NULL,
           CASE WHEN has_upper THEN 'all capitals' ELSE 'all lower case' END
           || ' where the column is mixed case'
    FROM o JOIN share USING (level, name_column)
    WHERE share.mixed >= ${MIXED_CASE_SHARE} AND outlier
  `;
}

function mixedScript(source: string): string {
  const scripts = CONFUSABLE_SCRIPTS.map((s) => `regexp_matches(w, '\\p{${s}}')::INT`);
  return `--sql
    SELECT DISTINCT 'mixed-script', level, name_column, code, name, NULL, NULL,
           NULL, 'a word mixes ${CONFUSABLE_SCRIPTS.join("/")} letters'
    FROM (
      SELECT *, unnest(regexp_split_to_array(name, '[^\\p{L}\\p{M}]+')) AS w
      FROM ${named(source)}
    )
    WHERE ${scripts.join(" + ")} > 1
  `;
}

const tokens = (text: string): string =>
  `trim(regexp_replace(lower(${text}), '[^\\p{L}\\p{N}]+', ' ', 'g'))`;

function codeInName(source: string): string {
  const has = (column: string): string =>
    `(length(${column}) >= ${CODE_IN_NAME_MIN_LENGTH} ` +
    `AND regexp_matches(${column}, '\\p{L}') ` +
    `AND regexp_matches(${column}, '\\p{N}') ` +
    `AND contains(' ' || ${tokens("name")} || ' ', ' ' || ${tokens(column)} || ' '))`;
  return perName(
    "code-in-name",
    source,
    `lower(trim(name)) <> lower(code) AND (${has("code")} OR ${has("parent_code")})`,
    "'the name contains a code'",
  );
}

const CHECKS: Array<[NameIssueKind, (source: string) => string]> = [
  ["blank-code", blankCode],
  ["blank-name", blank],
  ["placeholder-name", placeholder],
  ["duplicate-name", duplicate],
  ["name-conflict", conflict],
  ["encoding-artifact", encoding],
  ["normalized-duplicate-name", normalizedDuplicate],
  ["invisible-character", invisible],
  ["unnormalized-unicode", unnormalized],
  ["whitespace", whitespace],
  ["case-outlier", caseOutlier],
  ["mixed-script", mixedScript],
  ["code-in-name", codeInName],
];

// Writes `${prefix}_03`, every finding over `${prefix}_02`, and returns the kinds whose check failed.
export async function runNameChecks(
  conn: AsyncDuckDBConnection,
  prefix: string,
): Promise<NameIssueKind[]> {
  const source = `${prefix}_02`;
  const target = `${prefix}_03`;
  const failed: NameIssueKind[] = [];
  await createNameMacros(conn);
  await conn.query(`CREATE OR REPLACE TABLE ${target} (${COLUMNS})`);
  for (const [kind, build] of CHECKS) {
    try {
      await conn.query(`INSERT INTO ${target} ${build(source)}`);
    } catch (e) {
      // One failing check must not hide the rest.
      console.warn(`${kind} check failed; reporting none`, e);
      failed.push(kind);
    }
  }
  // One defect per unit: a blank name or an encoding error explains the rest.
  await conn.query(`--sql
    DELETE FROM ${target} AS i USING ${target} AS d
    WHERE i.code_a = d.code_a AND i.level = d.level
      AND i.name_column = d.name_column AND i.code_b IS NULL
      AND ((d.kind = 'blank-name' AND i.kind <> 'blank-name')
           OR (d.kind = 'encoding-artifact' AND i.kind = 'invisible-character'))
  `);
  return failed;
}
