import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Shared hierarchical-code primitive, ported from topo-tools-py's core.code.
// A leaf module: no dependency on code-refactor or code-update.

export interface CodeFormat {
  rootCode: string;
  delimiter: string;
  minWidth: number;
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function resolveCodeFormat(rootCode: string, delimiter: string, minWidth: number): CodeFormat {
  if (!rootCode) throw new Error("root code must be a non-empty string");
  if (delimiter.length !== 1) {
    throw new Error(`delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }
  if (minWidth < 1) throw new Error(`min width must be positive, got ${minWidth}`);
  return { rootCode, delimiter, minWidth };
}

export function parseCode(code: string, fmt: CodeFormat): string[] {
  return code.split(fmt.delimiter);
}

export function buildCode(components: string[], fmt: CodeFormat): string {
  return components.join(fmt.delimiter);
}

// Drops code's own last component, i.e. its parent's code; throws for a
// root-only, single-component code (no parent to return).
export function parentPrefix(code: string, fmt: CodeFormat): string {
  const components = parseCode(code, fmt);
  if (components.length <= 1) {
    throw new Error(`code ${JSON.stringify(code)} has no parent under this format`);
  }
  return buildCode(components.slice(0, -1), fmt);
}

export function lastComponent(code: string, fmt: CodeFormat): string {
  const components = parseCode(code, fmt);
  return components[components.length - 1];
}

export function rewriteChildCode(oldCode: string, newParentCode: string, fmt: CodeFormat): string {
  return `${newParentCode}${fmt.delimiter}${lastComponent(oldCode, fmt)}`;
}

// parentCode's next unused integer among its own live direct children.
export function nextAvailableInteger(
  existingCodes: string[],
  parentCode: string,
  fmt: CodeFormat,
): number {
  const prefix = `${parentCode}${fmt.delimiter}`;
  let maxN = 0;
  for (const code of existingCodes) {
    if (!code.startsWith(prefix)) continue;
    const tail = code.slice(prefix.length);
    if (tail.includes(fmt.delimiter) || !/^\d+$/.test(tail)) continue;
    maxN = Math.max(maxN, Number(tail));
  }
  return maxN + 1;
}

export interface AssignNewCodesOptions {
  idColumn: string;
  parentColumn: string;
  sortColumns: string[];
  codeColumn: string;
  fmt: CodeFormat;
  existingCodes?: string[];
}

// Ranks each row into a fresh sequential code per parent group. lpad
// truncates over-width, so width widens to fit an overflowing tail first.
export async function assignNewCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  opts: AssignNewCodesOptions,
): Promise<void> {
  const { idColumn, parentColumn, sortColumns, codeColumn, fmt } = opts;
  const existingCodes = opts.existingCodes ?? [];
  const qTable = quoteIdent(table);
  const qId = quoteIdent(idColumn);
  const qParent = quoteIdent(parentColumn);
  const qCode = quoteIdent(codeColumn);

  const parentRows = (await conn.query(`SELECT DISTINCT ${qParent} AS p FROM ${qTable}`)).toArray() as Array<{
    p: string | null;
  }>;

  const baseByParent = new Map<string, number>();
  for (const { p } of parentRows) {
    if (p === null) continue;
    baseByParent.set(p, nextAvailableInteger(existingCodes, p, fmt));
  }

  const baseTable = quoteIdent(`${table}_code_base`);
  await conn.query(`--sql
    CREATE OR REPLACE TEMP TABLE ${baseTable} (parent_code VARCHAR, base_n INTEGER)
  `);
  if (baseByParent.size > 0) {
    const values = [...baseByParent.entries()].map(([p, n]) => `(${quoteLiteral(p)}, ${n})`).join(", ");
    await conn.query(`INSERT INTO ${baseTable} VALUES ${values}`);
  }

  const orderSql = sortColumns.map((c) => `${quoteIdent(c)} NULLS LAST`).join(", ");
  const rankedTable = quoteIdent(`${table}_code_ranked`);
  await conn.query(`--sql
    CREATE OR REPLACE TEMP TABLE ${rankedTable} AS
    WITH numbered AS (
      SELECT
        src.${qId} AS id_value,
        src.${qParent} AS parent_code,
        CAST(
          base.base_n - 1 + ROW_NUMBER() OVER (
            PARTITION BY src.${qParent} ORDER BY ${orderSql}
          ) AS VARCHAR
        ) AS tail
      FROM ${qTable} src
      JOIN ${baseTable} base ON base.parent_code = src.${qParent}
    )
    SELECT
      id_value,
      parent_code || ${quoteLiteral(fmt.delimiter)} ||
      lpad(tail, CAST(GREATEST(${fmt.minWidth}, LENGTH(tail)) AS INTEGER), '0') AS new_code
    FROM numbered
  `);

  await conn.query(`--sql
    UPDATE ${qTable} t
    SET ${qCode} = r.new_code
    FROM ${rankedTable} r
    WHERE t.${qId} = r.id_value
  `);

  await conn.query(`DROP TABLE IF EXISTS ${baseTable}`);
  await conn.query(`DROP TABLE IF EXISTS ${rankedTable}`);
}

const SAMPLE_LIMIT = 10_000;

export async function detectCodeFormat(
  conn: AsyncDuckDBConnection,
  table: string,
  codeColumn: string,
): Promise<CodeFormat> {
  const qc = quoteIdent(codeColumn);
  const rows = (
    await conn.query(`--sql
      SELECT DISTINCT ${qc} AS v FROM ${quoteIdent(table)}
      WHERE ${qc} IS NOT NULL
      LIMIT ${SAMPLE_LIMIT}
    `)
  ).toArray() as Array<{ v: string }>;
  const codes = rows.map((r) => r.v);
  if (codes.length === 0) {
    throw new Error(`no non-null values in ${JSON.stringify(codeColumn)} to detect a code format from`);
  }

  const delimiter = detectDelimiter(codes, codeColumn);
  const rootCode = detectRoot(codes, delimiter, codeColumn);
  const minWidth = detectMinWidth(codes, delimiter, codeColumn);
  return { rootCode, delimiter, minWidth };
}

// The single non-alphanumeric character common to every sampled code.
function detectDelimiter(codes: string[], codeColumn: string): string {
  let candidates: Set<string> | null = null;
  for (const code of codes) {
    const nonAlnum = new Set([...code].filter((c) => !/[a-zA-Z0-9]/.test(c)));
    if (candidates === null) {
      candidates = nonAlnum;
    } else {
      const prior: Set<string> = candidates;
      candidates = new Set([...prior].filter((c) => nonAlnum.has(c)));
    }
  }
  if (!candidates || candidates.size !== 1) {
    throw new Error(
      `could not infer a single recurring delimiter from ${JSON.stringify(codeColumn)}'s existing values: ${JSON.stringify(codeColumn)} may not be a formatted hierarchical code column`,
    );
  }
  return [...candidates][0];
}

// The shared first delimiter-split component across every sampled code.
function detectRoot(codes: string[], delimiter: string, codeColumn: string): string {
  const roots = new Set(codes.map((c) => c.split(delimiter)[0]));
  if (roots.size !== 1) {
    throw new Error(
      `${JSON.stringify(codeColumn)} does not share one constant root component (found ${JSON.stringify([...roots].sort())}); it may not be this dataset's own root-anchored hierarchy column`,
    );
  }
  return [...roots][0];
}

// The mode, not the min or max, so one overflow-widened tail can't skew it.
function detectMinWidth(codes: string[], delimiter: string, codeColumn: string): number {
  const widths: number[] = [];
  for (const code of codes) {
    if (!code.includes(delimiter)) continue;
    for (const part of code.split(delimiter).slice(1)) widths.push(part.length);
  }
  if (widths.length === 0) {
    throw new Error(`no delimited components found in ${JSON.stringify(codeColumn)} to measure width from`);
  }
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best = widths[0];
  let bestCount = -1;
  for (const [w, c] of counts) {
    if (c > bestCount) {
      best = w;
      bestCount = c;
    }
  }
  return best;
}
