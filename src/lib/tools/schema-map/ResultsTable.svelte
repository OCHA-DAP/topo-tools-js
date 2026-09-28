<script lang="ts">
  import type { EditableRow } from "./pipeline/editor";

  let {
    rows = [],
    values = null,
    samples = {},
    issues = new Map(),
    emptyText = "No columns to map.",
    onSetKeep,
    onSetAllKeep,
    onSetName,
    onReset,
    onResetAll,
    onMove,
    onSortDefault,
    inDefaultOrder = true,
    orderEdited = false,
  }: {
    rows?: EditableRow[];
    values?: Record<string, string | null> | null;
    samples?: Record<string, string[]>;
    issues?: Map<string, string>;
    emptyText?: string;
    onSetKeep: (source: string, keep: boolean) => void;
    onSetAllKeep: (keep: boolean) => void;
    onSetName: (source: string, name: string) => void;
    onReset: (source: string) => void;
    onResetAll: () => void;
    onMove: (source: string, toIndex: number) => void;
    onSortDefault: () => void;
    inDefaultOrder?: boolean;
    orderEdited?: boolean;
  } = $props();

  let dragging = $state<string | null>(null);
  let dropAt = $state<number | null>(null);

  function onDragStart(e: DragEvent, source: string): void {
    const row = (e.currentTarget as HTMLElement).closest("tr");
    if (row) e.dataTransfer?.setDragImage(row, 16, 16);
    e.dataTransfer?.setData("text/plain", source);
    dragging = source;
  }

  function onDragOver(e: DragEvent, index: number): void {
    if (!dragging) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    if (dragging && dropAt !== null) {
      const from = rows.findIndex((r) => r.sourceColumn === dragging);
      onMove(dragging, dropAt > from ? dropAt - 1 : dropAt);
    }
    onDragEnd();
  }

  function onDragEnd(): void {
    dragging = null;
    dropAt = null;
  }

  function onGripKey(e: KeyboardEvent, source: string, index: number): void {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    onMove(source, index + (e.key === "ArrowUp" ? -1 : 1));
    requestAnimationFrame(() => target.focus());
  }

  const hasNotes = $derived(rows.some((r) => r.note));
  const keptCount = $derived(rows.filter((r) => r.keep).length);
  const anyEdited = $derived(orderEdited || rows.some((r) => r.edited));

  function rowClass(r: EditableRow): string {
    if (!r.keep) return "dropped";
    if (r.note.startsWith("supplemental")) return "supplemental";
    if (r.note.startsWith("ambiguous")) return "ambiguous";
    return "resolved";
  }

</script>

<div class="rt-table">
  {#if rows.length === 0}
    <p class="rt-empty">{emptyText}</p>
  {:else}
    <div class="rt-toolbar">
      <button type="button" onclick={onSortDefault} disabled={inDefaultOrder}>
        Sort to default order
      </button>
      <button type="button" onclick={onResetAll} disabled={!anyEdited}>Reset all edits</button>
    </div>
    <table>
      <thead>
        <tr>
          <th class="fit check">
            <input
              type="checkbox"
              aria-label="Keep all columns"
              checked={keptCount === rows.length}
              indeterminate={keptCount > 0 && keptCount < rows.length}
              onchange={(e) => onSetAllKeep(e.currentTarget.checked)}
            />
          </th>
          <th class="fit">Source</th>
          <th class="fit">Target</th>
          <th class="fit num" title="Unique values">Unique</th>
          <th class="flex">{values ? "Value" : "Examples"}</th>
          {#if hasNotes}<th class="flex">Note</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as r, i (r.sourceColumn)}
          {@const issue = issues.get(r.sourceColumn)}
          <tr
            class={rowClass(r)}
            class:edited={r.edited}
            class:drag-source={dragging === r.sourceColumn}
            class:drop-before={dropAt === i}
            class:drop-after={dropAt === rows.length && i === rows.length - 1}
            ondragover={(e) => onDragOver(e, i)}
            ondrop={onDrop}
          >
            <td class="check">
              <button
                type="button"
                class="grip"
                draggable="true"
                title="Drag to reorder (Alt+↑/↓)"
                aria-label={`Reorder ${r.sourceColumn}`}
                ondragstart={(e) => onDragStart(e, r.sourceColumn)}
                ondragend={onDragEnd}
                onkeydown={(e) => onGripKey(e, r.sourceColumn, i)}>⋮⋮</button
              >
              <input
                type="checkbox"
                aria-label={`Keep ${r.sourceColumn}`}
                checked={r.keep}
                onchange={(e) => onSetKeep(r.sourceColumn, e.currentTarget.checked)}
              />
            </td>
            <td>{r.sourceColumn}</td>
            <td class="target">
              <div class="target-cell">
                <input
                  type="text"
                  value={r.input}
                  disabled={!r.keep}
                  aria-label={`Target for ${r.sourceColumn}`}
                  aria-invalid={issue ? "true" : undefined}
                  title={issue}
                  class:invalid={issue}
                  oninput={(e) => onSetName(r.sourceColumn, e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="icon"
                  class:hidden={!r.edited}
                  title={r.baseTarget ? `Reset to ${r.baseTarget}` : "Reset to dropped"}
                  onclick={() => onReset(r.sourceColumn)}>↺</button
                >
              </div>
              {#if issue}<p class="issue">{issue}</p>{/if}
            </td>
            <td class="num">{r.uniqueCount}</td>
            {#if values}
              <td class="flex value" title={values[r.sourceColumn]}>
                {values[r.sourceColumn] ?? "–"}
              </td>
            {:else}
              {@const ex = (samples[r.sourceColumn] ?? []).join(", ")}
              <td class="flex value sample" title={ex}>{ex || "–"}</td>
            {/if}
            {#if hasNotes}<td class="flex note" title={r.note || null}>{r.note || "–"}</td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .rt-table {
    height: 100%;
    overflow: auto;
  }
  .rt-toolbar {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
  }
  .rt-toolbar button {
    font-size: 0.75rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    color: #374151;
    cursor: pointer;
  }
  .rt-toolbar button:hover:not(:disabled) {
    background: #f3f4f6;
  }
  .rt-toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
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
    padding: 0.4rem 0.5rem;
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
  td.value,
  .target-cell input {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  td.num {
    text-align: right;
    color: #4b5563;
  }
  td.note {
    color: #6b7280;
  }
  td.sample {
    color: #9ca3af;
  }
  .target-cell {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .target-cell input {
    width: 8.5rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.8rem;
    color: inherit;
    background: #fff;
  }
  .target-cell input:disabled {
    color: #9ca3af;
    background: #f9fafb;
    text-decoration: line-through;
  }
  .target-cell input.invalid {
    border-color: #dc2626;
    background: #fef2f2;
  }
  .icon {
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: #6b7280;
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
  }
  .icon.hidden {
    visibility: hidden;
  }
  .icon:hover {
    border-color: #d1d5db;
    background: #f3f4f6;
    color: #111;
  }
  .issue {
    margin: 0.2rem 0 0;
    font-size: 0.7rem;
    color: #b91c1c;
  }
  tr.resolved .target-cell input {
    color: #15803d;
    font-weight: 600;
  }
  tr.supplemental td.note {
    color: #a16207;
  }
  tr.ambiguous td.note {
    color: #b91c1c;
  }
  tr.dropped td:nth-child(2) {
    color: #9ca3af;
  }
  th.check,
  td.check {
    padding-right: 0;
    white-space: nowrap;
  }
  th.check {
    padding-left: 1.45rem;
  }
  .grip {
    padding: 0 0.15rem;
    border: none;
    background: none;
    color: #9ca3af;
    font-size: 0.75rem;
    letter-spacing: -0.15em;
    cursor: grab;
    vertical-align: middle;
  }
  .grip:hover,
  .grip:focus-visible {
    color: #374151;
  }
  tr.drag-source {
    opacity: 0.4;
  }
  tr.drop-before td {
    box-shadow: inset 0 2px #6366f1;
  }
  tr.drop-after td {
    box-shadow: inset 0 -2px #6366f1;
  }
  tr.edited td:first-child {
    box-shadow: inset 3px 0 #6366f1;
  }
  .rt-empty {
    padding: 1rem;
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
  }
</style>
