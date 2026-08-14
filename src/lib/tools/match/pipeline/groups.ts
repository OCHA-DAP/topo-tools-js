import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { PipelineError, runPipeline } from "$lib/tools/edge-extender/pipeline/index";
import { clipToBoundary } from "$lib/db/clipToBoundary";

export interface GroupInfo {
  parentFid: number;
  childCount: number;
  label: string;
}

export interface GroupResult extends GroupInfo {
  status: "done" | "error";
  error?: string;
  failedStage?: number;
}

export type GroupStageFn = (
  groupIndex: number,
  groupTotal: number,
  group: GroupInfo,
  stage: number,
  stageLabel: string,
) => void;

export type GroupDoneFn = (groupIndex: number, groupTotal: number, result: GroupResult) => void;

// One row per non-empty group, joined against an optional human-readable
// label column on the parent layer (see detectColumns in $lib/db/columns).
export async function listGroups(
  conn: AsyncDuckDBConnection,
  nameColumn: string | null,
): Promise<GroupInfo[]> {
  const nameExpr = nameColumn
    ? `CAST(a.${JSON.stringify(nameColumn)} AS VARCHAR)`
    : "NULL::VARCHAR";
  const rows = await conn.query(`--sql
    SELECT g.parent_fid AS parent_fid, g.child_count AS child_count, ${nameExpr} AS name
    FROM ge_groups g
    LEFT JOIN parent_layer_attr a ON a.fid = g.parent_fid
    ORDER BY g.parent_fid
  `);
  return (
    rows.toArray() as Array<{
      parent_fid: bigint | number;
      child_count: bigint | number;
      name: string | null;
    }>
  ).map((r) => {
    const parentFid = Number(r.parent_fid);
    return {
      parentFid,
      childCount: Number(r.child_count),
      label: r.name ? `${r.name} (fid ${parentFid})` : `Group ${parentFid}`,
    };
  });
}

// Runs edge-extender's pipeline once per group, sequentially: populate
// layer_01/layer_attr with that group's child-unit subset, run the pipeline
// unmodified (it self-cleans its own internal tables at the start of every
// call, so this is safe to call in a loop), clip the result directly against
// the known parent geometry (no need for edge-extender's own runClip, which
// exists to *select* an unknown polygon — here the parent polygon is already
// known), and accumulate into ge_results. A failing group is recorded and
// skipped rather than aborting the whole batch — Edge Extender's stage 2/5
// OOMs aren't retried, and one bad group shouldn't block the rest.
export async function runGroups(
  conn: AsyncDuckDBConnection,
  groups: GroupInfo[],
  onStage: GroupStageFn,
  onDone: GroupDoneFn,
): Promise<GroupResult[]> {
  await conn.query("CREATE OR REPLACE TABLE ge_results (fid BIGINT, geom GEOMETRY)");
  await conn.query(
    "CREATE OR REPLACE TABLE ge_dropped (unit_a BIGINT, parent_fid BIGINT, reason VARCHAR, geom GEOMETRY)",
  );
  const results: GroupResult[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let result: GroupResult;
    console.log(`[EE-DEBUG] ##### GROUP START: ${group.label} (${i + 1}/${groups.length}) #####`);
    try {
      console.log("[EE-DEBUG] group:1 populate layer_01/layer_attr");
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_01 AS
        SELECT fid, geom FROM child_layer_01
        WHERE fid IN (SELECT child_fid FROM ge_assignment WHERE parent_fid = ${group.parentFid})
      `);
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_attr AS
        SELECT * FROM child_layer_attr
        WHERE fid IN (SELECT child_fid FROM ge_assignment WHERE parent_fid = ${group.parentFid})
      `);

      await runPipeline(
        conn,
        (stage, stageLabel) => onStage(i, groups.length, group, stage, stageLabel),
        { skipOutputClean: true },
      );

      console.log("[EE-DEBUG] group:2 clip vs parent geometry (ge_group_clip)");
      await clipToBoundary(
        conn,
        "layer_05",
        `SELECT geom FROM parent_layer_01 WHERE fid = ${group.parentFid}`,
        "ge_group_clip",
      );
      console.log("[EE-DEBUG] group:3 insert into ge_results");
      await conn.query(`--sql
        INSERT INTO ge_results
        SELECT fid, geom FROM ge_group_clip
        WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      `);

      console.log(`[EE-DEBUG] ##### GROUP DONE (success): ${group.label} #####`);
      result = { ...group, status: "done" };
    } catch (e) {
      console.log(`[EE-DEBUG] ##### GROUP DONE (error): ${group.label}: ${e instanceof Error ? e.message : String(e)} #####`);
      const msg = e instanceof Error ? e.message : String(e);
      const failedStage = e instanceof PipelineError ? e.failedStage : undefined;
      result = { ...group, status: "error", error: msg, failedStage };
      // Record this group's children as dropped, for the downstream issues
      // export. Reads from child_layer_01 filtered by ge_assignment (not the
      // group's own scratch layer_01) so it works even if the group failed
      // before layer_01 was fully built. Best-effort: a failure here
      // shouldn't abort the batch over a nice-to-have.
      try {
        const escapedMsg = msg.replace(/'/g, "''");
        await conn.query(`--sql
          INSERT INTO ge_dropped
          SELECT fid AS unit_a, ${group.parentFid} AS parent_fid,
                 '${escapedMsg}' AS reason, geom
          FROM child_layer_01
          WHERE fid IN (SELECT child_fid FROM ge_assignment WHERE parent_fid = ${group.parentFid})
        `);
      } catch (recordError) {
        console.warn(`Failed to record dropped group ${group.label}:`, recordError);
      }
    } finally {
      // If the group above failed because the connection is OOM-poisoned,
      // these cleanup queries fail too — and since that throw would otherwise
      // escape this finally block, it replaces the already-caught error above
      // and aborts the whole loop instead of recording one failed group and
      // continuing (WASM linear memory can't recover mid-session either way).
      try {
        await conn.query("DROP TABLE IF EXISTS layer_01");
        await conn.query("DROP TABLE IF EXISTS layer_attr");
        await conn.query("DROP TABLE IF EXISTS layer_05");
        await conn.query("DROP TABLE IF EXISTS ge_group_clip");
      } catch (cleanupError) {
        console.warn(`Cleanup after group ${group.label} failed:`, cleanupError);
      }
    }
    results.push(result);
    onDone(i, groups.length, result);
  }

  return results;
}
