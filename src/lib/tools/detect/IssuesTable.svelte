<script lang="ts">
  import { fmtArea, fmtLength } from "$lib/utils/format";
  import type { IssueKind, IssueRow } from "./pipeline";

  let {
    rows = [],
    selectedKey = null,
    detectionFailed = new Set<IssueKind>(),
    onSelect,
    onHover,
  }: {
    rows?: IssueRow[];
    selectedKey?: string | null;
    // Kinds whose detection query failed (even after retry) — a 0 count for
    // these means "couldn't check," not "clean." See pipeline/index.ts.
    detectionFailed?: Set<IssueKind>;
    onSelect?: (key: string) => void;
    onHover?: (key: string | null) => void;
  } = $props();

  let showGaps = $state(true);
  let showOverlaps = $state(true);

  const gapCount = $derived(rows.filter((r) => r.kind === "gap").length);
  const overlapCount = $derived(rows.filter((r) => r.kind === "overlap").length);
  const visible = $derived(
    rows.filter((r) => {
      if (r.kind === "gap") return showGaps;
      if (r.kind === "overlap") return showOverlaps;
      return false;
    }),
  );

  function kindLabel(r: IssueRow): string {
    return r.kind === "overlap" ? "Overlap" : "Gap";
  }

  function kindClass(r: IssueRow): string {
    return r.kind === "overlap" ? "dt-key--overlap" : "dt-key--gap";
  }
</script>

<div class="dt-table-wrap">
  <div class="dt-toolbar">
    <div class="dt-counts">
      <span class="dt-total-count">{rows.length} {rows.length === 1 ? "issue" : "issues"} found</span>
    </div>
    <div class="dt-filters">
      <button
        type="button"
        class="dt-chip dt-chip--overlap"
        class:off={!showOverlaps}
        class:failed={detectionFailed.has("overlap")}
        onclick={() => (showOverlaps = !showOverlaps)}
        title={detectionFailed.has("overlap")
          ? "Overlap detection failed for this coverage (even after retrying) — this count may be incomplete, not necessarily 0"
          : "Toggle overlaps"}
      >
        <span class="dt-key dt-key--overlap"></span> Overlaps {overlapCount}{#if detectionFailed.has("overlap")}<span
            class="dt-fail-mark">⚠</span
          >{/if}
      </button>
      <button
        type="button"
        class="dt-chip dt-chip--gap"
        class:off={!showGaps}
        class:failed={detectionFailed.has("gap")}
        onclick={() => (showGaps = !showGaps)}
        title={detectionFailed.has("gap")
          ? "Gap detection failed for this coverage (even after retrying) — this count may be incomplete, not necessarily 0"
          : "Toggle gaps"}
      >
        <span class="dt-key dt-key--gap"></span> Gaps {gapCount}{#if detectionFailed.has("gap")}<span
            class="dt-fail-mark">⚠</span
          >{/if}
      </button>
    </div>
  </div>

  {#if detectionFailed.size > 0}
    <p class="dt-detect-warn">
      ⚠ Detection failed for {[...detectionFailed].join(", ")} on this coverage, even after retrying —
      those counts may be incomplete. This isn't necessarily a clean coverage; GEOS couldn't fully check it.
    </p>
  {/if}

  {#if rows.length === 0}
    {#if detectionFailed.size > 0}
      <p class="dt-empty dt-empty--warn">Nothing to show — detection failed (see warning above).</p>
    {:else}
      <p class="dt-empty">No issues found — the coverage is clean. 🎉</p>
    {/if}
  {:else}
    <div class="dt-scroll">
      <table class="dt-table">
        <thead>
          <tr>
            <th>Type</th>
            <th class="dt-num" style="width:88px">Max width</th>
            <th class="dt-num" style="width:80px">Area</th>
          </tr>
        </thead>
        <tbody onmouseleave={() => onHover?.(null)}>
          {#each visible as r (r.key)}
            <tr
              class:selected={r.key === selectedKey}
              onclick={() => onSelect?.(r.key)}
              onmouseenter={() => onHover?.(r.key)}
            >
              <td>
                <span class="dt-key {kindClass(r)}"></span>
                {kindLabel(r)}
              </td>
              <td class="dt-num">{fmtLength(r.maxWidthM)}</td>
              <td class="dt-num">{fmtArea(r.areaM2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .dt-table-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #fff;
  }
  .dt-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .dt-counts {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .dt-total-count {
    font-size: 0.82rem;
    font-weight: 600;
    color: #374151;
  }
  .dt-filters {
    display: flex;
    gap: 0.4rem;
  }
  .dt-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    background: #fff;
    color: #374151;
    cursor: pointer;
  }
  .dt-chip.off {
    opacity: 0.4;
  }
  .dt-chip.failed {
    border-color: #f59e0b;
    background: #fffbeb;
    color: #92400e;
  }
  .dt-fail-mark {
    margin-left: 0.25rem;
    color: #d97706;
  }
  .dt-detect-warn {
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.78rem;
    color: #92400e;
    background: #fffbeb;
    border-bottom: 1px solid #fde68a;
  }
  .dt-empty {
    padding: 1.25rem 0.9rem;
    font-size: 0.85rem;
    color: #047857;
    margin: 0;
  }
  .dt-empty--warn {
    color: #92400e;
  }
  .dt-scroll {
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .dt-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    table-layout: fixed;
  }
  .dt-table thead th {
    position: sticky;
    top: 0;
    background: #f9fafb;
    text-align: left;
    font-weight: 600;
    color: #4b5563;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
    z-index: 1;
  }
  .dt-table td {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid #f3f4f6;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dt-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .dt-table tbody tr {
    cursor: pointer;
  }
  .dt-table tbody tr:hover {
    background: #f3f4f6;
  }
  .dt-table tbody tr.selected {
    background: #fef3c7;
  }
  .dt-key {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    margin-right: 0.35rem;
    vertical-align: middle;
  }
  .dt-key--overlap {
    background: #e11d48;
  }
  .dt-key--gap {
    background: #f59e0b;
  }
</style>
