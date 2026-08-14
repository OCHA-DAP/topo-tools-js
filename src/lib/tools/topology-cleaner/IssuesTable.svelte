<script lang="ts">
  import { fmtArea, fmtLength } from "$lib/utils/format";
  import type { IssueKind, IssueRow } from "./pipeline";

  let {
    rows = [],
    selectedKey = null,
    fixedKeys = new Set<string>(),
    detectionFailed = new Set<IssueKind>(),
    onSelect,
    onHover,
  }: {
    rows?: IssueRow[];
    selectedKey?: string | null;
    fixedKeys?: Set<string>;
    // Kinds whose detection query failed (even after retry) — a 0 count for
    // these means "couldn't check," not "clean." See pipeline/issues.ts.
    detectionFailed?: Set<IssueKind>;
    onSelect?: (key: string) => void;
    onHover?: (key: string | null) => void;
  } = $props();

  let showGaps = $state(true);
  let showOverlaps = $state(true);

  const gapCount = $derived(rows.filter((r) => r.kind === "gap").length);
  const overlapCount = $derived(rows.filter((r) => r.kind === "overlap").length);
  // Both overlaps and gaps are auto-fixed (overlaps always, gaps within the gap-width).
  const isFixable = (r: IssueRow) => r.kind === "overlap" || r.kind === "gap";
  const fixableCount = $derived(rows.filter(isFixable).length);
  const fixedCount = $derived(rows.filter((r) => isFixable(r) && fixedKeys.has(r.key)).length);
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
    return r.kind === "overlap" ? "tc-key--overlap" : "tc-key--gap";
  }

  function isFixed(r: IssueRow): boolean {
    return isFixable(r) && fixedKeys.has(r.key);
  }
</script>

<div class="tc-table-wrap">
  <div class="tc-toolbar">
    <div class="tc-counts">
      <span class="tc-fixed-count" class:all={fixedCount === fixableCount && fixableCount > 0}>
        {fixedCount} of {fixableCount} fixed
      </span>
    </div>
    <div class="tc-filters">
      <button
        type="button"
        class="tc-chip tc-chip--overlap"
        class:off={!showOverlaps}
        class:failed={detectionFailed.has("overlap")}
        onclick={() => (showOverlaps = !showOverlaps)}
        title={detectionFailed.has("overlap")
          ? "Overlap detection failed for this coverage (even after retrying) — this count may be incomplete, not necessarily 0"
          : "Toggle overlaps"}
      >
        <span class="tc-key tc-key--overlap"></span> Overlaps {overlapCount}{#if detectionFailed.has("overlap")}<span class="tc-fail-mark">⚠</span>{/if}
      </button>
      <button
        type="button"
        class="tc-chip tc-chip--gap"
        class:off={!showGaps}
        class:failed={detectionFailed.has("gap")}
        onclick={() => (showGaps = !showGaps)}
        title={detectionFailed.has("gap")
          ? "Gap detection failed for this coverage (even after retrying) — this count may be incomplete, not necessarily 0"
          : "Toggle gaps"}
      >
        <span class="tc-key tc-key--gap"></span> Gaps {gapCount}{#if detectionFailed.has("gap")}<span class="tc-fail-mark">⚠</span>{/if}
      </button>
    </div>
  </div>

  {#if detectionFailed.size > 0}
    <p class="tc-detect-warn">
      ⚠ Detection failed for {[...detectionFailed].join(", ")} on this coverage, even after retrying —
      those counts may be incomplete. This isn't necessarily a clean coverage; GEOS couldn't fully check it.
    </p>
  {/if}

  {#if rows.length === 0}
    {#if detectionFailed.size > 0}
      <p class="tc-empty tc-empty--warn">Nothing to show — detection failed (see warning above).</p>
    {:else}
      <p class="tc-empty">No issues found — the coverage is clean. 🎉</p>
    {/if}
  {:else}
    <div class="tc-scroll">
      <table class="tc-table">
        <thead>
          <tr>
            <th class="tc-check-cell" style="width:46px">Fixed</th>
            <th>Type</th>
            <th class="tc-num" style="width:88px">Max width</th>
            <th class="tc-num" style="width:80px">Area</th>
          </tr>
        </thead>
        <tbody onmouseleave={() => onHover?.(null)}>
          {#each visible as r (r.key)}
            <tr
              class:selected={r.key === selectedKey}
              onclick={() => onSelect?.(r.key)}
              onmouseenter={() => onHover?.(r.key)}
            >
              <td class="tc-check-cell">
                <span class="tc-checkbox" class:tc-checkbox--on={isFixed(r)}>
                  {#if isFixed(r)}✓{/if}
                </span>
              </td>
              <td>
                <span class="tc-key {kindClass(r)}"></span>
                {kindLabel(r)}
              </td>
              <td class="tc-num">{fmtLength(r.maxWidthM)}</td>
              <td class="tc-num">{fmtArea(r.areaM2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .tc-table-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #fff;
  }
  .tc-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .tc-counts {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .tc-fixed-count {
    font-size: 0.82rem;
    font-weight: 600;
    color: #b45309;
  }
  .tc-fixed-count.all {
    color: #15803d;
  }
  .tc-filters {
    display: flex;
    gap: 0.4rem;
  }
  .tc-chip {
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
  .tc-chip.off {
    opacity: 0.4;
  }
  .tc-chip.failed {
    border-color: #f59e0b;
    background: #fffbeb;
    color: #92400e;
  }
  .tc-fail-mark {
    margin-left: 0.25rem;
    color: #d97706;
  }
  .tc-detect-warn {
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.78rem;
    color: #92400e;
    background: #fffbeb;
    border-bottom: 1px solid #fde68a;
  }
  .tc-empty {
    padding: 1.25rem 0.9rem;
    font-size: 0.85rem;
    color: #047857;
    margin: 0;
  }
  .tc-empty--warn {
    color: #92400e;
  }
  .tc-scroll {
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .tc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    table-layout: fixed;
  }
  .tc-table thead th {
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
  .tc-table td {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid #f3f4f6;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tc-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tc-table tbody tr {
    cursor: pointer;
  }
  .tc-table tbody tr:hover {
    background: #f3f4f6;
  }
  .tc-table tbody tr.selected {
    background: #fef3c7;
  }
  .tc-key {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    margin-right: 0.35rem;
    vertical-align: middle;
  }
  .tc-key--overlap {
    background: #e11d48;
  }
  .tc-key--gap {
    background: #f59e0b;
  }
  .tc-check-cell {
    text-align: center;
  }
  .tc-checkbox {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border: 1.5px solid #d1d5db;
    border-radius: 3px;
    background: #fff;
    font-size: 10px;
    color: transparent;
  }
  .tc-checkbox--on {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
  }
</style>
