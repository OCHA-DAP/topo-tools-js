import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";

// Ported from topo-tools-py's core/schema_detect/_03_checks.py.

const COLUMNS = "kind VARCHAR, level INTEGER, column_name VARCHAR, code VARCHAR, reason VARCHAR";

// Each level's code column and the next coarser level's.
type Parent = [level: number, child: string, parent: string];
type Check = (p: string, table: string, parents: Parent[]) => string;

const lit = (text: string): string => "'" + text.replace(/'/g, "''") + "'";

const problems: Check = (p) => `--sql
  SELECT problem, level, column_name, NULL, reason FROM ${p}_02 WHERE problem IS NOT NULL
`;

const families = (p: string): string =>
  `SELECT * FROM ${p}_02 WHERE problem IS NULL AND family IS NOT NULL`;

// A tied family (two levels, two spellings) goes to the separator/case style
// most of the layer's other columns use.
const naming: Check = (p) => `--sql
  WITH s AS (${families(p)}), styled AS (
    SELECT family, raw_family, regexp_replace(regexp_replace(
      regexp_replace(raw_family, '[0-9]+', '', 'g'),
      '[a-z]+', 'a', 'g'), '[A-Z]+', 'A', 'g') AS style
    FROM s WHERE anchored
  ), counts AS (
    SELECT family, raw_family, count(*) AS n,
           bool_or(style = (SELECT mode(style) FROM styled)) AS fits
    FROM styled GROUP BY ALL
  ), usual AS (
    SELECT family, arg_max(raw_family, (n, fits, raw_family)) AS raw
    FROM counts GROUP BY family
  ), example AS (
    SELECT family, min(column_name) AS example
    FROM s JOIN usual USING (family)
    WHERE anchored AND raw_family = raw GROUP BY family
  )
  SELECT 'column-naming', level, column_name, NULL,
         CASE WHEN example IS NULL
              THEN printf('does not follow level %d''s column naming', level)
              ELSE printf('named unlike %s, its match at another level', example)
         END
  FROM s LEFT JOIN usual USING (family) LEFT JOIN example USING (family)
  WHERE NOT anchored OR raw_family IS DISTINCT FROM raw
`;

// A family at one level only (e.g. a reference name) is level-specific.
const columnSet: Check = (p) => `--sql
  WITH s AS (${families(p)}),
  levels AS (SELECT DISTINCT level FROM s),
  families AS (
    SELECT family, list(DISTINCT level) AS found, min(column_name) AS example
    FROM s GROUP BY family
  )
  SELECT 'column-set-mismatch', l.level, NULL, NULL,
         printf('no column like %s, which another level has', f.example)
  FROM families f CROSS JOIN levels l
  WHERE NOT list_contains(f.found, l.level) AND len(f.found) > 1
`;

const pairs = (p: string, parents: Parent[], select: (...args: Parent) => string): string =>
  parents.length === 0
    ? `SELECT NULL, NULL, NULL, NULL, NULL FROM ${p}_02 WHERE false`
    : parents.map((x) => `SELECT * FROM (${select(...x)})`).join(" UNION ALL ");

const multipleParents: Check = (p, table, parents) =>
  pairs(p, parents, (level, child, parent) => {
    const [c, q] = [quoteIdent(child), quoteIdent(parent)];
    return `--sql
      SELECT 'multiple-parents', ${level}, ${lit(child)}, ${c}::VARCHAR,
             printf('under %d parents: %s', count(DISTINCT ${q}),
                    string_agg(DISTINCT ${q}::VARCHAR, ', ' ORDER BY ${q}::VARCHAR))
      FROM ${quoteIdent(table)}
      WHERE ${c} IS NOT NULL AND ${q} IS NOT NULL
      GROUP BY ${c} HAVING count(DISTINCT ${q}) > 1
    `;
  });

const orphan: Check = (p, table, parents) =>
  pairs(p, parents, (level, child, parent) => {
    const [c, q] = [quoteIdent(child), quoteIdent(parent)];
    return `--sql
      SELECT DISTINCT 'orphan-child', ${level}, ${lit(child)}, ${c}::VARCHAR,
             ${lit(`has no parent code in ${parent}`)}
      FROM ${quoteIdent(table)} WHERE ${c} IS NOT NULL AND ${q} IS NULL
    `;
  });

const CHECKS: Array<[string, Check]> = [
  ["problems", problems],
  ["column-naming", naming],
  ["column-set-mismatch", columnSet],
  ["multiple-parents", multipleParents],
  ["orphan-child", orphan],
];

// Writes `${p}_03`, every finding over `${p}_02` and table, and returns the checks that failed.
export async function runSchemaChecks(
  conn: AsyncDuckDBConnection,
  p: string,
  table: string,
): Promise<string[]> {
  const codes = (
    await conn.query(`--sql
      SELECT level, column_name FROM ${p}_02
      WHERE is_code AND problem IS NULL ORDER BY level
    `)
  ).toArray() as Array<{ level: number; column_name: string }>;
  const parents: Parent[] = codes
    .slice(1)
    .map((c, i) => [Number(c.level), c.column_name, codes[i].column_name]);
  const failed: string[] = [];
  await conn.query(`CREATE OR REPLACE TABLE ${p}_03 (${COLUMNS})`);
  for (const [kind, build] of CHECKS) {
    try {
      await conn.query(`INSERT INTO ${p}_03 ${build(p, table, parents)}`);
    } catch (e) {
      // One failing check must not hide the rest.
      console.warn(`${kind} check failed; reporting none`, e);
      failed.push(kind);
    }
  }
  return failed;
}
