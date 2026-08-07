import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { UnionFind } from "../unionFind";

export type RelClass =
  | "unchanged"
  | "renamed"
  | "modified"
  | "relocated"
  | "merge"
  | "split"
  | "complex"
  | "created"
  | "removed";

// Single source of truth for order/colors — shared by the table toolbar, map
// fill expression, and legend.
export const REL_ORDER: RelClass[] = [
  "unchanged",
  "renamed",
  "modified",
  "relocated",
  "merge",
  "split",
  "complex",
  "created",
  "removed",
];

export const REL_COLORS: Record<RelClass, string> = {
  unchanged: "#9ec5ab",
  renamed: "#c4a86c",
  modified: "#e5b250",
  relocated: "#3fb8c4",
  merge: "#5a8fd8",
  split: "#e07550",
  complex: "#b25dab",
  created: "#6cc46c",
  removed: "#d35a5a",
};

export interface ClassifyOptions {
  tauMatch: number;
  tauSame: number;
  linkByCode: boolean;
  linkByName: boolean;
  // Only consulted when both linkByCode and linkByName are true.
  linkMode: "either" | "both";
}

interface PairRow {
  a_fid: number;
  b_fid: number;
  shared_area: number;
  coverage_a: number;
  coverage_b: number;
  iou: number;
  a_code: string | null;
  a_name: string | null;
  b_code: string | null;
  b_name: string | null;
}

interface PairOut extends PairRow {
  cluster_id: number;
  relationship_class: RelClass;
  match_method: "identity" | "spatial";
}

interface SingletonOut {
  side: "a" | "b";
  fid: number;
  cluster_id: number;
  relationship_class: RelClass;
}

const num = (v: unknown): number => {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return Number(v);
};

const str = (v: unknown): string | null => (v == null ? null : String(v));

// Values that appear exactly once per side — a value shared by multiple
// polygons can't identify one unit, and matching on it would falsely union them all.
function uniqueValues(
  rows: Array<Record<string, unknown>>,
  col: string,
): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = str(r[col]);
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [v, n] of counts) if (n === 1) out.add(v);
  return out;
}

// True if a pair's code/name match per the user's link settings; only unique
// values qualify (duplicates like "No_Pcode" would cause spurious mass-linking).
function identityMatch(
  p: PairRow,
  opts: ClassifyOptions,
  uniqueCodesA: Set<string>,
  uniqueCodesB: Set<string>,
  uniqueNamesA: Set<string>,
  uniqueNamesB: Set<string>,
): boolean {
  if (!opts.linkByCode && !opts.linkByName) return false;
  const codeMatch =
    opts.linkByCode &&
    p.a_code != null &&
    p.a_code === p.b_code &&
    uniqueCodesA.has(p.a_code) &&
    uniqueCodesB.has(p.b_code!);
  const nameMatch =
    opts.linkByName &&
    p.a_name != null &&
    p.a_name === p.b_name &&
    uniqueNamesA.has(p.a_name) &&
    uniqueNamesB.has(p.b_name!);
  if (opts.linkByCode && opts.linkByName) {
    return opts.linkMode === "both" ? codeMatch && nameMatch : codeMatch || nameMatch;
  }
  return codeMatch || nameMatch;
}

export async function stageClassify(
  conn: AsyncDuckDBConnection,
  opts: ClassifyOptions,
): Promise<{ pairs: PairOut[]; singletons: SingletonOut[] }> {
  const { tauMatch, tauSame } = opts;
  const pairs: PairRow[] = (
    await conn.query(`--sql
      SELECT p.*, ak.code AS a_code, ak.name AS a_name, bk.code AS b_code, bk.name AS b_name
      FROM cw_pairs p
      LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
      LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid
    `)
  )
    .toArray()
    .map((r: Record<string, unknown>) => ({
      a_fid: num(r.a_fid),
      b_fid: num(r.b_fid),
      shared_area: num(r.shared_area),
      coverage_a: num(r.coverage_a),
      coverage_b: num(r.coverage_b),
      iou: num(r.iou),
      a_code: str(r.a_code),
      a_name: str(r.a_name),
      b_code: str(r.b_code),
      b_name: str(r.b_name),
    }));

  const aRows = (await conn.query("SELECT fid, code, name FROM cw_a_keyed")).toArray() as Array<
    Record<string, unknown>
  >;
  const bRows = (await conn.query("SELECT fid, code, name FROM cw_b_keyed")).toArray() as Array<
    Record<string, unknown>
  >;

  const allA = aRows.map((r) => num(r.fid));
  const allB = bRows.map((r) => num(r.fid));

  // Values that appear exactly once per side — only these are eligible as
  // identity anchors. Duplicates (e.g. "No_Pcode") are excluded.
  const uniqueCodesA = uniqueValues(aRows, "code");
  const uniqueCodesB = uniqueValues(bRows, "code");
  const uniqueNamesA = uniqueValues(aRows, "name");
  const uniqueNamesB = uniqueValues(bRows, "name");

  // Union-find over "a:<fid>"/"b:<fid>". Two-phase when identity linking is on:
  // identity claims go first, guarded so a genuine split/merge isn't falsely absorbed; spatial tauMatch fills the rest.
  const uf = new UnionFind();
  for (const fid of allA) uf.add(`a:${fid}`);
  for (const fid of allB) uf.add(`b:${fid}`);

  // Pre-compute which B fids each A fid reaches via tauMatch (and vice versa),
  // and which fids have any identity match at all (used for the coverage check).
  const spatialNeighborsA = new Map<number, Set<number>>();
  const spatialNeighborsB = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (Math.max(p.coverage_a, p.coverage_b) < tauMatch) continue;
    if (!spatialNeighborsA.has(p.a_fid)) spatialNeighborsA.set(p.a_fid, new Set());
    if (!spatialNeighborsB.has(p.b_fid)) spatialNeighborsB.set(p.b_fid, new Set());
    spatialNeighborsA.get(p.a_fid)!.add(p.b_fid);
    spatialNeighborsB.get(p.b_fid)!.add(p.a_fid);
  }

  // A/B fids that have at least one potential identity match — used to decide
  // whether a fid's spatial neighbors are "identity-covered."
  const identityASet = new Set<number>();
  const identityBSet = new Set<number>();
  if (opts.linkByCode || opts.linkByName) {
    for (const p of pairs) {
      if (identityMatch(p, opts, uniqueCodesA, uniqueCodesB, uniqueNamesA, uniqueNamesB)) {
        identityASet.add(p.a_fid);
        identityBSet.add(p.b_fid);
      }
    }
  }

  const passingPairs: Array<PairRow & { rescuedByIdentity: boolean }> = [];
  const claimedA = new Set<number>();
  const claimedB = new Set<number>();

  if (opts.linkByCode || opts.linkByName) {
    for (const p of pairs) {
      if (!identityMatch(p, opts, uniqueCodesA, uniqueCodesB, uniqueNamesA, uniqueNamesB)) continue;
      if (claimedA.has(p.a_fid) || claimedB.has(p.b_fid)) continue;
      // Claim only if every other spatial-tauMatch neighbor on both sides is
      // also identity-covered; otherwise this signals a real split/merge for Phase 2.
      const aSpatialBFids = spatialNeighborsA.get(p.a_fid) ?? new Set<number>();
      const bSpatialAFids = spatialNeighborsB.get(p.b_fid) ?? new Set<number>();
      const allANeighborsCovered = [...aSpatialBFids].every(
        (bOther) => bOther === p.b_fid || identityBSet.has(bOther),
      );
      const allBNeighborsCovered = [...bSpatialAFids].every(
        (aOther) => aOther === p.a_fid || identityASet.has(aOther),
      );
      if (!allANeighborsCovered || !allBNeighborsCovered) continue;
      claimedA.add(p.a_fid);
      claimedB.add(p.b_fid);
      const spatialAlsoPass = Math.max(p.coverage_a, p.coverage_b) >= tauMatch;
      uf.union(`a:${p.a_fid}`, `b:${p.b_fid}`);
      passingPairs.push({ ...p, rescuedByIdentity: !spatialAlsoPass });
    }
  }

  for (const p of pairs) {
    if (Math.max(p.coverage_a, p.coverage_b) < tauMatch) continue;
    if (claimedA.has(p.a_fid) || claimedB.has(p.b_fid)) continue;
    uf.union(`a:${p.a_fid}`, `b:${p.b_fid}`);
    passingPairs.push({ ...p, rescuedByIdentity: false });
  }

  const components = uf.components();
  // Map root key → numeric cluster_id
  const clusterId = new Map<string, number>();
  let nextId = 1;
  for (const root of components.keys()) clusterId.set(root, nextId++);

  // Per-cluster counts and best IoU (for 1:1 unchanged/modified distinction)
  const clusterMembers = new Map<number, { aFids: number[]; bFids: number[] }>();
  for (const [root, members] of components.entries()) {
    const id = clusterId.get(root)!;
    const aFids: number[] = [];
    const bFids: number[] = [];
    for (const m of members) {
      const [side, fidStr] = m.split(":");
      const fid = Number(fidStr);
      if (side === "a") aFids.push(fid);
      else bFids.push(fid);
    }
    clusterMembers.set(id, { aFids, bFids });
  }

  // Best IoU per cluster for the 1:1 IoU check (worst-case: one pair).
  const clusterBestIou = new Map<number, number>();
  // True only if every connecting edge was an identity rescue, not a spatial
  // tauMatch pass. Only meaningful for 1:1 clusters (the only case it's read for).
  const clusterRescuedOnly = new Map<number, boolean>();
  // True if any pair's code/name differs across versions; only consulted in
  // identity-linking mode — geometry-first mode never yields "renamed".
  const clusterHasAttrChange = new Map<number, boolean>();
  for (const p of passingPairs) {
    const root = uf.find(`a:${p.a_fid}`);
    const id = clusterId.get(root)!;
    const prev = clusterBestIou.get(id) ?? -Infinity;
    if (p.iou > prev) clusterBestIou.set(id, p.iou);
    const prevRescuedOnly = clusterRescuedOnly.get(id) ?? true;
    clusterRescuedOnly.set(id, prevRescuedOnly && p.rescuedByIdentity);
    const codeChanged =
      opts.linkByCode && p.a_code != null && p.b_code != null && p.a_code !== p.b_code;
    const nameChanged =
      opts.linkByName && p.a_name != null && p.b_name != null && p.a_name !== p.b_name;
    const attrChanged = codeChanged || nameChanged;
    clusterHasAttrChange.set(id, (clusterHasAttrChange.get(id) ?? false) || attrChanged);
  }

  // Classify each cluster
  const clusterClass = new Map<number, RelClass>();
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const na = aFids.length;
    const nb = bFids.length;
    let cls: RelClass;
    if (na === 1 && nb === 1) {
      if (clusterRescuedOnly.get(id)) {
        cls = "relocated";
      } else {
        const iou = clusterBestIou.get(id) ?? 0;
        if (iou >= tauSame) {
          cls = clusterHasAttrChange.get(id) ? "renamed" : "unchanged";
        } else {
          cls = "modified";
        }
      }
    } else if (na === 1 && nb > 1) {
      cls = "split";
    } else if (na > 1 && nb === 1) {
      cls = "merge";
    } else if (na > 1 && nb > 1) {
      cls = "complex";
    } else if (na === 1 && nb === 0) {
      cls = "removed";
    } else if (na === 0 && nb === 1) {
      cls = "created";
    } else {
      cls = "complex"; // should not happen for connected components, defensive
    }
    clusterClass.set(id, cls);
  }

  // Build pairs out (only passing edges)
  const pairsOut: PairOut[] = passingPairs.map((p) => {
    const id = clusterId.get(uf.find(`a:${p.a_fid}`))!;
    return {
      ...p,
      cluster_id: id,
      relationship_class: clusterClass.get(id)!,
      match_method: p.rescuedByIdentity ? "identity" : "spatial",
    };
  });

  // Singletons: fids whose cluster has zero on the other side
  const singletonsOut: SingletonOut[] = [];
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const cls = clusterClass.get(id)!;
    if (bFids.length === 0) {
      for (const fid of aFids) {
        singletonsOut.push({ side: "a", fid, cluster_id: id, relationship_class: cls });
      }
    } else if (aFids.length === 0) {
      for (const fid of bFids) {
        singletonsOut.push({ side: "b", fid, cluster_id: id, relationship_class: cls });
      }
    }
  }

  await writeBack(conn, pairsOut, singletonsOut, clusterMembers, clusterClass);
  await rebuildChangelog(conn, opts);
  return { pairs: pairsOut, singletons: singletonsOut };
}

async function writeBack(
  conn: AsyncDuckDBConnection,
  pairs: PairOut[],
  singletons: SingletonOut[],
  clusterMembers: Map<number, { aFids: number[]; bFids: number[] }>,
  clusterClass: Map<number, RelClass>,
): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cw_pairs_classified");
  await conn.query("DROP TABLE IF EXISTS cw_polygon_class");

  await conn.query(`--sql
    CREATE TABLE cw_pairs_classified (
      a_fid INTEGER,
      b_fid INTEGER,
      shared_area DOUBLE,
      coverage_a DOUBLE,
      coverage_b DOUBLE,
      iou DOUBLE,
      cluster_id INTEGER,
      relationship_class VARCHAR,
      match_method VARCHAR
    )
  `);

  await conn.query(`--sql
    CREATE TABLE cw_polygon_class (
      side VARCHAR,
      fid INTEGER,
      cluster_id INTEGER,
      relationship_class VARCHAR
    )
  `);

  // Bulk insert via batched VALUES. Limit batch to ~500 rows per insert so the
  // generated SQL stays under DuckDB's reasonable statement-size envelope.
  const BATCH = 500;
  const sqlNum = (n: number) => (Number.isFinite(n) ? n.toString() : "NULL");
  const sqlStr = (s: string) => "'" + s.replace(/'/g, "''") + "'";

  for (let i = 0; i < pairs.length; i += BATCH) {
    const slice = pairs.slice(i, i + BATCH);
    const values = slice
      .map(
        (p) =>
          `(${p.a_fid}, ${p.b_fid}, ${sqlNum(p.shared_area)}, ${sqlNum(p.coverage_a)}, ${sqlNum(
            p.coverage_b,
          )}, ${sqlNum(p.iou)}, ${p.cluster_id}, ${sqlStr(p.relationship_class)}, ${sqlStr(p.match_method)})`,
      )
      .join(", ");
    await conn.query(`INSERT INTO cw_pairs_classified VALUES ${values}`);
  }

  // One row per a_fid/b_fid regardless of singleton status — render.ts needs a
  // row for matched fids too, to join cluster_id onto overlap pieces.
  const polyRows: Array<{ side: "a" | "b"; fid: number; cluster_id: number; cls: RelClass }> = [];
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const cls = clusterClass.get(id)!;
    for (const fid of aFids) polyRows.push({ side: "a", fid, cluster_id: id, cls });
    for (const fid of bFids) polyRows.push({ side: "b", fid, cluster_id: id, cls });
  }
  for (let i = 0; i < polyRows.length; i += BATCH) {
    const slice = polyRows.slice(i, i + BATCH);
    const values = slice
      .map((p) => `(${sqlStr(p.side)}, ${p.fid}, ${p.cluster_id}, ${sqlStr(p.cls)})`)
      .join(", ");
    await conn.query(`INSERT INTO cw_polygon_class VALUES ${values}`);
  }

  // singletons not separately written — already in cw_polygon_class; table.ts
  // reconstructs singleton rows from there with NULL on the missing side.
  void singletons;
}

export async function rebuildChangelog(
  conn: AsyncDuckDBConnection,
  opts: ClassifyOptions,
): Promise<void> {
  const { tauMatch, tauSame, linkByCode, linkByName, linkMode } = opts;
  const boolStr = (b: boolean) => (b ? "TRUE" : "FALSE");
  const sqlStr = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  await conn.query("DROP TABLE IF EXISTS cw_changelog");
  await conn.query(`--sql
    CREATE TABLE cw_changelog AS
    SELECT
      ak.code AS code_a,
      ak.name AS name_a,
      bk.code AS code_b,
      bk.name AS name_b,
      p.relationship_class,
      p.match_method,
      ROUND(p.coverage_a, 3) AS a_in_b,
      ROUND(p.coverage_b, 3) AS b_in_a,
      ROUND(p.iou, 3) AS similarity,
      ${tauMatch} AS threshold_match,
      ${tauSame} AS threshold_unchanged,
      ${boolStr(linkByCode)} AS link_by_code,
      ${boolStr(linkByName)} AS link_by_name,
      ${sqlStr(linkMode)} AS link_mode
    FROM cw_pairs_classified p
    LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
    LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid

    UNION ALL

    SELECT ak.code AS code_a, ak.name AS name_a,
           NULL AS code_b, NULL AS name_b,
           pc.relationship_class,
           NULL AS match_method,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity,
           ${tauMatch} AS threshold_match, ${tauSame} AS threshold_unchanged,
           ${boolStr(linkByCode)} AS link_by_code,
           ${boolStr(linkByName)} AS link_by_name,
           ${sqlStr(linkMode)} AS link_mode
    FROM cw_polygon_class pc
    JOIN (
      SELECT cluster_id, SUM(CASE WHEN side='b' THEN 1 ELSE 0 END) AS nb
      FROM cw_polygon_class GROUP BY cluster_id
    ) cnt ON cnt.cluster_id = pc.cluster_id
    LEFT JOIN cw_a_keyed ak ON ak.fid = pc.fid
    WHERE pc.side = 'a' AND cnt.nb = 0

    UNION ALL

    SELECT NULL AS code_a, NULL AS name_a,
           bk.code AS code_b, bk.name AS name_b,
           pc.relationship_class,
           NULL AS match_method,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity,
           ${tauMatch} AS threshold_match, ${tauSame} AS threshold_unchanged,
           ${boolStr(linkByCode)} AS link_by_code,
           ${boolStr(linkByName)} AS link_by_name,
           ${sqlStr(linkMode)} AS link_mode
    FROM cw_polygon_class pc
    JOIN (
      SELECT cluster_id, SUM(CASE WHEN side='a' THEN 1 ELSE 0 END) AS na
      FROM cw_polygon_class GROUP BY cluster_id
    ) cnt ON cnt.cluster_id = pc.cluster_id
    LEFT JOIN cw_b_keyed bk ON bk.fid = pc.fid
    WHERE pc.side = 'b' AND cnt.na = 0

    ORDER BY relationship_class, code_a NULLS LAST, code_b NULLS LAST
  `);
}
