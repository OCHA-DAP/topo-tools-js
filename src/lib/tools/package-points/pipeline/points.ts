import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  detectLevelCodes,
  detectLevelColumnsOrSingle,
  detectRootLevel,
  groupFamiliesByLevel,
  levelFamilyNames,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

export interface LevelPlan {
  level: number;
  groupBy: string[];
  exclude: string[];
  rename: Map<string, string>;
}

export interface LevelPlanResult {
  plans: LevelPlan[];
  rootInjected: boolean;
}

async function tableColumnSet(conn: AsyncDuckDBConnection, table: string): Promise<Set<string>> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  return new Set((desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name));
}

// A whole-table-constant level one coarser than the finest auto-detected
// level is injected as a synthetic level 0 when found (rootInjected).
export async function resolvePointLevelPlans(
  conn: AsyncDuckDBConnection,
  attrTable: string,
  schema: TargetSchema | null,
): Promise<LevelPlanResult> {
  if (schema !== null) {
    const levels = await detectLevels(conn, attrTable, schema);
    const cols = await tableColumnSet(conn, attrTable);
    const identity = new Map<number, string[]>();
    const renameByLevel = new Map<number, Map<string, string>>();
    for (const level of levels) {
      const code = schema.codeField.replace("{n}", String(level));
      const name = schema.nameField.replace("{n}", String(level));
      identity.set(level, [code, name].filter((c) => cols.has(c)));
      const rename = new Map<string, string>();
      if (cols.has(code)) rename.set(code, "code");
      if (cols.has(name)) rename.set(name, "name");
      renameByLevel.set(level, rename);
    }
    const plans = levels.map((level) => ({
      level,
      groupBy: [schema.codeField.replace("{n}", String(level))],
      exclude: levels.filter((l) => l !== level).flatMap((l) => identity.get(l)!),
      rename: renameByLevel.get(level)!,
    }));
    return { plans, rootInjected: false };
  }

  const levelColumns = await detectLevelColumnsOrSingle(conn, attrTable);
  let root = null;
  try {
    root = await detectRootLevel(conn, attrTable, levelColumns);
  } catch {
    root = null;
  }
  let rootInjected = false;
  if (root !== null && !levelColumns.has(0)) {
    levelColumns.set(0, root);
    rootInjected = true;
  }

  const levels = [...levelColumns.keys()].sort((a, b) => a - b);
  const families = await groupFamiliesByLevel(conn, attrTable, levelColumns);
  const levelCodes = await detectLevelCodes(conn, attrTable).catch(() => new Map<number, string>());

  const plans = levels.map((level) => {
    const cols = levelColumns.get(level)!;
    // groupBy is unfiltered by naming anchor and can sweep in incidental
    // numeric columns at row-unique cardinality; identityColumns is safe.
    const identitySet = new Set(cols.identityColumns);
    const groupBy = cols.groupBy.filter((c) => identitySet.has(c));
    if (groupBy.length === 0 && cols.groupBy.length > 0) {
      throw new Error(`level ${level} has no anchor-conforming code column to group by in ${attrTable}`);
    }
    const exclude = levels
      .filter((l) => l !== level)
      .flatMap((l) => levelColumns.get(l)!.identityColumns);
    const rename = levelFamilyNames(families, level, levelCodes.get(level) ?? null);
    return { level, groupBy, exclude, rename };
  });
  return { plans, rootInjected };
}
