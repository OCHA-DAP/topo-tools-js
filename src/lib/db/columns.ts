import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

const CODE_PATTERNS = [
  /^(gid|fid)$/i,
  /^(geoid|pcode|adm[0-9]?_?pcode|p_code|iso3?|iso_a[23])$/i,
  /^(fips|hasc|adm_code)$/i,
  /^(code|id)$/i,
  /code$/i,
];

const NAME_PATTERNS = [
  /^name$/i,
  /^(.*_name|name_.*)$/i,
  /^(label|title|display.*|short.*name|long.*name)$/i,
  /^adm[0-9]?_?(en|name)$/i,
];

export interface ColumnGuess {
  code: string | null;
  name: string | null;
  all: string[];
}

export async function detectColumns(
  conn: AsyncDuckDBConnection,
  attrTable: string,
): Promise<ColumnGuess> {
  const desc = await conn.query(`DESCRIBE ${attrTable}`);
  const rows = desc.toArray() as Array<{ column_name: string; column_type: string }>;
  const all = rows.map((r) => r.column_name).filter((c) => c !== "fid");

  const pickFirst = (patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const hit = all.find((c) => p.test(c));
      if (hit) return hit;
    }
    return null;
  };

  return {
    code: pickFirst(CODE_PATTERNS),
    name: pickFirst(NAME_PATTERNS),
    all,
  };
}
