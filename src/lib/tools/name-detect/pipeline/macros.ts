import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  CP1252_SPECIALS,
  IMPLAUSIBLE_REPAIR_PATTERN,
  INVISIBLE_PATTERN,
  MOJIBAKE_PATTERN,
  ODD_SPACE_PATTERN,
} from "./constants";

// Creates name_repair_mojibake(s) and name_clean(s), the safe, meaning-preserving fixes.
export async function createNameMacros(conn: AsyncDuckDBConnection): Promise<void> {
  const specials = CP1252_SPECIALS.map(([cp, byte]) => `WHEN ${cp} THEN ${byte}`).join(" ");
  await conn.query(`--sql
    CREATE OR REPLACE MACRO name_cp1252_byte(c) AS
      CASE WHEN unicode(c) < 256 THEN unicode(c)
           ELSE CASE unicode(c) ${specials} END END
  `);
  // Re-encode as cp1252 and decode as UTF-8; NULL unless every character
  // maps to a byte, the bytes are valid UTF-8 and the result is plausible.
  await conn.query(`--sql
    CREATE OR REPLACE MACRO name_repair_mojibake(s) AS (
      WITH b AS (
        SELECT list_transform(string_split(s, ''), c -> name_cp1252_byte(c)) AS bytes
      )
      SELECT CASE
        WHEN regexp_matches(r, '${IMPLAUSIBLE_REPAIR_PATTERN}') THEN NULL
        ELSE r
      END
      FROM (
        SELECT CASE
          WHEN NOT regexp_matches(s, '${MOJIBAKE_PATTERN}') THEN NULL
          WHEN list_count(bytes) < length(s) THEN NULL
          ELSE try(decode(unhex(array_to_string(
            list_transform(bytes, x -> printf('%02X', x)), ''))))
        END AS r
        FROM b
      )
    )
  `);
  await conn.query(`--sql
    CREATE OR REPLACE MACRO name_clean(s) AS trim(regexp_replace(
      nfc_normalize(regexp_replace(regexp_replace(
        coalesce(name_repair_mojibake(s), s),
        '${ODD_SPACE_PATTERN}', ' ', 'g'),
        '${INVISIBLE_PATTERN}', '', 'g')),
      ' {2,}', ' ', 'g'))
  `);
}
