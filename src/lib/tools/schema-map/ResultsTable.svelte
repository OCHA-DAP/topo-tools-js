<script lang="ts">
  import type { CrosswalkRow } from "./pipeline/index";

  let {
    rows = [] as CrosswalkRow[],
    values = null,
  }: { rows?: CrosswalkRow[]; values?: Record<string, string | null> | null } = $props();

  const hasNotes = $derived(rows.some((r) => r.note));

  function rowClass(r: CrosswalkRow): string {
    if (r.targetColumn) return "resolved";
    if (r.note.startsWith("supplemental")) return "supplemental";
    if (r.note.startsWith("ambiguous")) return "ambiguous";
    return "unmatched";
  }
</script>

<div class="rt-table">
  <table>
    <thead>
      <tr>
        <th class="fit">Source</th>
        <th class="fit">Target</th>
        <th class="fit num" title="Unique values">Unique</th>
        {#if values}<th class="flex">Value</th>{/if}
        {#if hasNotes}<th class="flex">Note</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.sourceColumn)}
        <tr class={rowClass(r)}>
          <td>{r.sourceColumn}</td>
          <td class="target">{r.targetColumn ?? "–"}</td>
          <td class="num">{r.uniqueCount}</td>
          {#if values}
            <td class="flex value" title={values[r.sourceColumn]}>{values[r.sourceColumn] ?? "–"}</td>
          {/if}
          {#if hasNotes}<td class="flex note" title={r.note || null}>{r.note || "–"}</td>{/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if rows.length === 0}
    <p class="rt-empty">No columns to map.</p>
  {/if}
</div>

<style>
  .rt-table {
    height: 100%;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead {
    position: sticky;
    top: 0;
    background: #f3f4f6;
    z-index: 1;
  }
  th,
  td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    white-space: nowrap;
  }
  .fit {
    width: 1%;
  }
  /* max-width: 0 stops cell content from widening the column, so it truncates instead. */
  .flex {
    width: 100%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  th.num {
    text-align: right;
  }
  th {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #4b5563;
  }
  td.target,
  td.value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  td.num {
    text-align: right;
    color: #4b5563;
  }
  td.note {
    color: #6b7280;
  }
  tr.resolved td.target {
    color: #15803d;
    font-weight: 600;
  }
  tr.supplemental td.note {
    color: #a16207;
  }
  tr.ambiguous td.note {
    color: #b91c1c;
  }
  tr.unmatched {
    color: #9ca3af;
  }
  .rt-empty {
    padding: 1rem;
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
  }
</style>
