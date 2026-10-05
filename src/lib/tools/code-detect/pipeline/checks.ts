import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  FORMAT_MIN_CODES,
  PREFIX_SHARE,
  SHAPE_SHARE,
  type CodeIssueKind,
} from "./constants";

const COLUMNS =
  "kind VARCHAR, level INTEGER, column_name VARCHAR, code_a VARCHAR, " +
  "name_a VARCHAR, code_b VARCHAR, name_b VARCHAR, reason VARCHAR";

// Each level's distinct (code, parent code) pairs, with their row count.
const codes = (source: string): string => `(
  SELECT level, code_column, code, parent_code, sum(row_count) AS row_count
  FROM ${source} WHERE code IS NOT NULL AND name_index = 0 GROUP BY ALL
)`;

const named = (source: string): string =>
  `(SELECT * FROM ${source} WHERE code IS NOT NULL AND name IS NOT NULL AND trim(name) <> '')`;

const blankCode = (source: string): string => `--sql
  SELECT 'blank-code', level, code_column, NULL, NULL, NULL, NULL,
         printf('%d units under %s have no code: %s', count(*),
                coalesce(parent_code, 'the root'),
                coalesce(string_agg(DISTINCT name, ' / '), 'no name either'))
  FROM ${source} WHERE code IS NULL AND name_index = 0
  GROUP BY level, code_column, parent_code
`;

const conflict = (source: string): string => `--sql
  SELECT 'name-conflict', level, name_column, code, names[1], code, names[2],
         printf('code %s has %d names: %s', code, len(names), array_to_string(names, ' / '))
  FROM (
    SELECT level, name_column, name_index, code, list_sort(list(DISTINCT name)) AS names
    FROM ${named(source)} GROUP BY ALL
  )
  WHERE len(names) > 1
  QUALIFY row_number() OVER (PARTITION BY level, code ORDER BY name_index) = 1
`;

// Finest-level codes on several features, with their (parent, name) variants.
const leafRepeats = (source: string): string => `(
  SELECT level, code_column, code, sum(row_count)::INT AS features,
         count(DISTINCT (parent_code, name)) AS variants
  FROM ${source}
  WHERE code IS NOT NULL AND name_index = 0 AND level = (SELECT max(level) FROM ${source})
  GROUP BY level, code_column, code HAVING sum(row_count) > 1
)`;

const duplicate = (source: string): string => `--sql
  SELECT 'duplicate-code', level, code_column, code, NULL, NULL, NULL,
         printf('code %s is on %d polygons with different names or parents', code, features)
  FROM ${leafRepeats(source)} WHERE variants > 1
`;

const split = (source: string): string => `--sql
  SELECT 'split-unit', level, code_column, code, NULL, NULL, NULL,
         printf('code %s is on %d polygons with the same name and parent: '
                'one unit split across polygons', code, features)
  FROM ${leafRepeats(source)} WHERE variants = 1
`;

const prefix = (source: string): string => `--sql
  WITH pairs AS (
    SELECT * FROM ${codes(source)} WHERE parent_code IS NOT NULL
  ), levels AS (
    SELECT level FROM pairs GROUP BY level
    HAVING count(*) >= ${FORMAT_MIN_CODES}
       AND avg(starts_with(code, parent_code)::INT) >= ${PREFIX_SHARE}
  )
  SELECT 'prefix-mismatch', level, code_column, code, NULL, parent_code, NULL,
         printf('code %s does not start with its parent code %s', code, parent_code)
  FROM pairs SEMI JOIN levels USING (level)
  WHERE NOT starts_with(code, parent_code)
`;

// Each level's distinct codes, every letter as A and digit as 9.
const shapes = (source: string): string => `--sql
  SELECT DISTINCT level, code_column, code,
         regexp_replace(regexp_replace(code, '\\p{L}', 'A', 'g'), '[0-9]', '9', 'g') AS shape
  FROM ${codes(source)}
`;

const shapeShares = (source: string): string => `--sql
  WITH s AS (${shapes(source)}), usual AS (
    SELECT level, mode(shape) AS usual, count(*) AS total
    FROM s GROUP BY level HAVING count(*) >= ${FORMAT_MIN_CODES}
  )
  SELECT level, usual, total, count(*) FILTER (WHERE shape = usual) AS n
  FROM s JOIN usual USING (level) GROUP BY ALL
`;

const formatOutlier = (source: string): string => `--sql
  SELECT 'format-outlier', s.level, s.code_column, s.code, NULL, NULL, NULL,
         printf('code %s is shaped %s, unlike %d of %d level %d codes (%s)',
                s.code, s.shape, u.n, u.total, s.level, u.usual)
  FROM (${shapes(source)}) s JOIN (${shapeShares(source)}) u USING (level)
  WHERE u.n >= u.total * ${SHAPE_SHARE} AND s.shape <> u.usual
`;

const formatUndetected = (source: string): string => `--sql
  SELECT DISTINCT 'format-undetected', s.level, s.code_column, NULL, NULL, NULL, NULL,
         printf('level %d codes share no common shape: the most common, %s, covers %d of %d',
                s.level, u.usual, u.n, u.total)
  FROM (${shapes(source)}) s JOIN (${shapeShares(source)}) u USING (level)
  WHERE u.n < u.total * ${SHAPE_SHARE}
`;

const CHECKS: Array<[CodeIssueKind, (source: string) => string]> = [
  ["blank-code", blankCode],
  ["name-conflict", conflict],
  ["duplicate-code", duplicate],
  ["split-unit", split],
  ["prefix-mismatch", prefix],
  ["format-outlier", formatOutlier],
  ["format-undetected", formatUndetected],
];

// Writes `${prefix}_03`, every finding over `${prefix}_02`.
export async function runCodeChecks(
  conn: AsyncDuckDBConnection,
  tablePrefix: string,
): Promise<void> {
  const source = `${tablePrefix}_02`;
  const target = `${tablePrefix}_03`;
  await conn.query(`CREATE OR REPLACE TABLE ${target} (${COLUMNS})`);
  for (const [kind, build] of CHECKS) {
    try {
      await conn.query(`INSERT INTO ${target} ${build(source)}`);
    } catch (e) {
      // One failing check must not hide the rest, and its failure is a finding.
      console.warn(`${kind} check failed`, e);
      const reason = `${kind} check failed: ${e instanceof Error ? e.message : String(e)}`;
      await conn.query(
        `INSERT INTO ${target} (kind, reason) VALUES ('check-failed', '${reason.replace(/'/g, "''")}')`,
      );
    }
  }
}
