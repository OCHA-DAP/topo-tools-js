<script lang="ts">
  import type { JoinedColumn, JoinIssueRow, SchemaJoinResult } from "./pipeline/index";

  let {
    result,
    inputCount,
    values,
    selectedKey,
    emptyText,
    onIssueClick,
  }: {
    result: SchemaJoinResult | null;
    inputCount: number;
    values: Record<string, string | null> | null;
    selectedKey: string | null;
    emptyText: string;
    onIssueClick: (issue: JoinIssueRow) => void;
  } = $props();

  const columns = $derived(result?.columns ?? null);
  const issues = $derived(result?.issues ?? []);
  const count = (kind: string) => issues.filter((i) => i.kind === kind).length;
  const noOverlap = $derived(count("no-overlap"));
  const lowOverlap = $derived(count("low-overlap"));
  const mismatch = $derived(count("value-mismatch"));

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const anyAdded = $derived(columns?.some((c) => c.source !== "input") ?? false);

  function sourceText(c: JoinedColumn): string {
    if (c.source === "input") return "Input";
    if (c.source === "matches") return "Input, matches join layer";
    if (c.source === "added") return "Added from join layer";
    return `Added from join layer's ${c.joinColumn} (${plural(c.differingRows, "differs", "differ")})`;
  }
</script>

<div class="jt-pane">
  {#if !columns}
    <p class="jt-empty">{emptyText}</p>
  {:else}
    <section class="summary">
      <p>
        <strong>{inputCount - noOverlap} of {plural(inputCount, "polygon", "polygons")}</strong>
        joined.
      </p>
      {#if noOverlap + lowOverlap + mismatch > 0}
        <ul>
          {#if noOverlap > 0}
            <li class="bad">{plural(noOverlap, "polygon overlaps", "polygons overlap")} no join polygon</li>
          {/if}
          {#if lowOverlap > 0}
            <li class="warn">{plural(lowOverlap, "polygon", "polygons")} below the minimum overlap</li>
          {/if}
          {#if mismatch > 0}
            <li class="warn">{plural(mismatch, "value differs", "values differ")} from the join layer's</li>
          {/if}
        </ul>
      {/if}
      {#if result && !result.sortColumn}
        <p class="muted">No column matches the code template, so rows keep their input order.</p>
      {/if}
    </section>

    <section>
      <h3>Joined columns</h3>
      {#if !anyAdded}
        <p class="jt-note">No admin hierarchy columns found in the join layer.</p>
      {/if}
      <table>
        <thead>
          <tr>
            <th class="fit">Column</th>
            <th class={values ? "fit" : "flex"}>Source</th>
            {#if values}<th class="flex">Selected polygon</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each columns as c (c.column)}
            <tr class={c.source}>
              <td class="fit value">{c.column}</td>
              <td class={values ? "fit" : "flex"}>{sourceText(c)}</td>
              {#if values}
                <td class="flex value" class:null={values[c.column] === null}>
                  {values[c.column] ?? "NULL"}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </section>


    <section>
      <h3>Issues ({issues.length})</h3>
      {#if issues.length === 0}
        <p class="jt-note">Every polygon joined with no conflicts.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th class="fit num">Row</th>
              <th class="fit">Kind</th>
              <th class="flex">Reason</th>
            </tr>
          </thead>
          <tbody>
            {#each issues as issue (issue.key)}
              <tr
                class="issue-row"
                class:selected={issue.key === selectedKey}
                tabindex="0"
                onclick={() => onIssueClick(issue)}
                onkeydown={(e) => e.key === "Enter" && onIssueClick(issue)}
              >
                <td class="fit num">{issue.unitA}</td>
                <td class="fit kind {issue.kind}">{issue.kind}</td>
                <td class="flex" title={issue.reason}>{issue.reason}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}
</div>

<style>
  .jt-pane {
    height: 100%;
    overflow: auto;
  }
  .summary {
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    color: var(--hdx-neutral-8);
  }
  .summary p {
    margin: 0 0 0.3rem;
  }
  .summary p.muted {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
  }
  .summary ul {
    margin: 0 0 0.3rem;
    padding-left: 1.1rem;
  }
  .summary li.bad {
    color: var(--hdx-error-6);
  }
  .summary li.warn {
    color: var(--hdx-warning-6);
  }
  section + section {
    border-top: 1px solid var(--hdx-neutral-1);
  }
  h3 {
    margin: 0;
    padding: 0.6rem 0.75rem 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead {
    background: var(--hdx-neutral-05);
  }
  th,
  td {
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--hdx-neutral-1);
    white-space: nowrap;
  }
  th:first-child,
  td:first-child {
    padding-left: 0.75rem;
  }
  th {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--hdx-neutral-7);
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
  .num {
    text-align: right;
  }
  td.num {
    color: var(--hdx-neutral-7);
  }
  td.value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  td.null {
    color: var(--hdx-neutral-5);
  }
  tr.child td:nth-child(2),
  tr.matches td:nth-child(2) {
    color: var(--hdx-neutral-7);
  }
  tr.added td:nth-child(2) {
    color: var(--hdx-success-6);
  }
  tr.sibling td:nth-child(2) {
    color: var(--hdx-warning-6);
  }
  .issue-row {
    cursor: pointer;
  }
  .issue-row:hover,
  .issue-row:focus-visible {
    background: var(--hdx-neutral-01);
    outline: none;
  }
  .issue-row.selected {
    background: var(--hdx-primary-05);
  }
  td.kind {
    font-size: 0.75rem;
  }
  td.kind.no-overlap {
    color: var(--hdx-error-6);
  }
  td.kind.low-overlap,
  td.kind.value-mismatch {
    color: var(--hdx-warning-6);
  }
  .jt-note {
    margin: 0;
    padding: 0 0.75rem 0.75rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
  }
  .jt-empty {
    padding: 1rem;
    text-align: center;
    color: var(--hdx-neutral-7);
    font-size: 0.875rem;
  }
</style>
