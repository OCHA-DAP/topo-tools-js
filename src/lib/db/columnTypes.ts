// Ported from topo-tools-py's core.constants type-prefix checks.

const TEMPORAL_DUCKDB_TYPE_PREFIXES = ["DATE", "TIME", "TIMESTAMP", "INTERVAL"];

export function isTemporalDuckdbType(duckdbType: string): boolean {
  const upper = duckdbType.toUpperCase();
  return TEMPORAL_DUCKDB_TYPE_PREFIXES.some((p) => upper.startsWith(p));
}

const NUMERIC_DUCKDB_TYPE_PREFIXES = [
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "FLOAT",
  "DOUBLE",
  "DECIMAL",
  "REAL",
];

export function isNumericDuckdbType(duckdbType: string): boolean {
  const upper = duckdbType.toUpperCase();
  return NUMERIC_DUCKDB_TYPE_PREFIXES.some((p) => upper.startsWith(p));
}
