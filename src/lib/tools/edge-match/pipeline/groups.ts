import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { PipelineError, runPipeline } from "$lib/tools/edge-extend/pipeline/index";
import { clipEngine } from "$lib/db/clipEngine";
import { emptyDetachedIssues, mergeDetachedParts } from "$lib/db/coverage";
import { queryToGeoJSON } from "$lib/db/geojson";

// Sentinel overlay_fid for the orphan passthrough pseudo-group (ported from
// topo-tools-py's PASSTHROUGH_OVERLAY_FID).
export const PASSTHROUGH_OVERLAY_FID = -1;

export interface GroupInfo {
  overlayFid: number;
  inputCount: number;
  label: string;
}

export interface GroupResult extends GroupInfo {
  status: "done" | "error";
  // This group's rows in ge_results, colored by group_id like the final output.
  geojson?: string;
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

// Map preview only, so a failure leaves the group done without one.
async function groupGeoJSON(
  conn: AsyncDuckDBConnection,
  overlayFid: number,
): Promise<string | undefined> {
  try {
    return await queryToGeoJSON(
      conn,
      `SELECT ST_AsGeoJSON(geom) AS _geom, ${overlayFid} AS group_id FROM ge_results
       WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${overlayFid})`,
    );
  } catch (e) {
    console.warn("group preview failed:", e);
    return undefined;
  }
}

// One row per non-empty group, joined against an optional human-readable
// label column on the overlay layer (see detectColumns in $lib/db/columns).
export async function listGroups(
  conn: AsyncDuckDBConnection,
  nameColumn: string | null,
): Promise<GroupInfo[]> {
  const nameExpr = nameColumn
    ? `CAST(a.${JSON.stringify(nameColumn)} AS VARCHAR)`
    : "NULL::VARCHAR";
  const rows = await conn.query(`--sql
    SELECT g.overlay_fid AS overlay_fid, g.input_count AS input_count, ${nameExpr} AS name
    FROM ge_groups g
    LEFT JOIN overlay_layer_attr a ON a.fid = g.overlay_fid
    ORDER BY (g.overlay_fid = ${PASSTHROUGH_OVERLAY_FID}), g.overlay_fid
  `);
  return (
    rows.toArray() as Array<{
      overlay_fid: bigint | number;
      input_count: bigint | number;
      name: string | null;
    }>
  ).map((r) => {
    const overlayFid = Number(r.overlay_fid);
    return {
      overlayFid,
      inputCount: Number(r.input_count),
      label:
        overlayFid === PASSTHROUGH_OVERLAY_FID
          ? "Input polygons outside the overlay"
          : r.name
            ? `${r.name} (fid ${overlayFid})`
            : `Group ${overlayFid}`,
    };
  });
}

// Runs edge-extend's pipeline once per group, sequentially: populate
// layer_01/layer_attr with that group's input-feature subset, run the pipeline
// unmodified (it self-cleans its own internal tables at the start of every
// call, so this is safe to call in a loop), clip the result directly against
// the known overlay feature geometry (no need for edge-extend's own runClip, which
// exists to *select* an unknown polygon — here the overlay feature polygon is already
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
    "CREATE OR REPLACE TABLE ge_dropped (unit_a BIGINT, overlay_fid BIGINT, reason VARCHAR, geom GEOMETRY)",
  );
  await conn.query(
    "CREATE OR REPLACE TABLE ge_clip_empty (unit_a BIGINT, overlay_fid BIGINT, geom GEOMETRY)",
  );
  await emptyDetachedIssues(conn, "ge_detached");
  const results: GroupResult[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let result: GroupResult;
    console.log(`[EE-DEBUG] ##### GROUP START: ${group.label} (${i + 1}/${groups.length}) #####`);
    try {
      console.log("[EE-DEBUG] group:1 populate layer_01/layer_attr");
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_01 AS
        SELECT fid, geom FROM input_layer_01
        WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
      `);
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_attr AS
        SELECT * FROM input_layer_attr
        WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
      `);

      await runPipeline(
        conn,
        (stage, stageLabel) => onStage(i, groups.length, group, stage, stageLabel),
        { skipOutputClean: true, skipInputHoleCheck: true },
      );

      if (group.overlayFid === PASSTHROUGH_OVERLAY_FID) {
        // Orphan passthrough: no real overlay feature boundary to clip against, so
        // the extended geometry goes straight into ge_results unclipped.
        console.log("[EE-DEBUG] group:2 passthrough, insert into ge_results unclipped");
        await conn.query(`--sql
          INSERT INTO ge_results
          SELECT fid, geom FROM layer_05
          WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        `);
      } else {
        console.log("[EE-DEBUG] group:2 clip vs overlay feature geometry (ge_group_clip)");
        await clipEngine(
          conn,
          "SELECT fid, geom FROM layer_05",
          `SELECT geom FROM overlay_layer_01 WHERE fid = ${group.overlayFid}`,
          "ge_group_clip",
        );
        await mergeDetachedParts(conn, "ge_group_clip", "ge_group_clip", {
          preClipSql: "SELECT fid, geom FROM layer_05",
          overlaySql: `SELECT geom FROM overlay_layer_01 WHERE fid = ${group.overlayFid}`,
          overlayFid: group.overlayFid,
          originalTable: "input_layer_01",
          issuesTable: "ge_group_detached",
        });
        await conn.query("INSERT INTO ge_detached SELECT * FROM ge_group_detached");
        console.log("[EE-DEBUG] group:3 insert into ge_results");
        await conn.query(`--sql
          INSERT INTO ge_results
          SELECT fid, geom FROM ge_group_clip
          WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        `);
        await conn.query(`--sql
          INSERT INTO ge_clip_empty
          SELECT fid AS unit_a, ${group.overlayFid} AS overlay_fid, geom FROM layer_05
          WHERE fid NOT IN (SELECT fid FROM ge_group_clip)
        `);
      }

      console.log(`[EE-DEBUG] ##### GROUP DONE (success): ${group.label} #####`);
      result = { ...group, status: "done", geojson: await groupGeoJSON(conn, group.overlayFid) };
    } catch (e) {
      console.log(
        `[EE-DEBUG] ##### GROUP DONE (error): ${group.label}: ${e instanceof Error ? e.message : String(e)} #####`,
      );
      const msg = e instanceof Error ? e.message : String(e);
      const failedStage = e instanceof PipelineError ? e.failedStage : undefined;
      result = { ...group, status: "error", error: msg, failedStage };
      // Record this group's input features as dropped, for the downstream issues
      // export. Reads from input_layer_01 filtered by ge_assignment (not the
      // group's own scratch layer_01) so it works even if the group failed
      // before layer_01 was fully built. Best-effort: a failure here
      // shouldn't abort the batch over a nice-to-have.
      try {
        const escapedMsg = msg.replace(/'/g, "''");
        await conn.query(`--sql
          INSERT INTO ge_dropped
          SELECT fid AS unit_a, ${group.overlayFid} AS overlay_fid,
                 '${escapedMsg}' AS reason, geom
          FROM input_layer_01
          WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
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
        await conn.query("DROP TABLE IF EXISTS ge_group_detached");
      } catch (cleanupError) {
        console.warn(`Cleanup after group ${group.label} failed:`, cleanupError);
      }
    }
    results.push(result);
    onDone(i, groups.length, result);
  }

  return results;
}
