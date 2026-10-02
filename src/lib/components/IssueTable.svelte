<script lang="ts" generics="I extends { key: string; kind: string; severity: string; reason: string }">
  import type { Snippet } from "svelte";

  let {
    issues,
    failed,
    selectedKey,
    emptyText,
    noneText,
    extra = "",
    summary = null,
    head,
    cells,
    onIssueClick,
  }: {
    issues: I[] | null;
    failed: string[];
    selectedKey: string | null;
    emptyText: string;
    noneText: string;
    extra?: string;
    summary?: string | null;
    head: Snippet;
    cells: Snippet<[I]>;
    onIssueClick: (issue: I) => void;
  } = $props();

  const errors = $derived(issues?.filter((i) => i.severity === "error").length ?? 0);
  const warnings = $derived(issues?.filter((i) => i.severity === "warn").length ?? 0);

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

<div class="it-pane">
  {#if !issues}
    <p class="it-empty">{emptyText}</p>
  {:else}
    <section class="summary">
      <p>
        {#if summary !== null}
          {summary}
        {:else}
          <strong>{plural(issues.length, "finding", "findings")}</strong>:
          {plural(errors, "error", "errors")}, {plural(warnings, "warning", "warnings")}{extra}.
        {/if}
      </p>
      {#if failed.length > 0}
        <p class="bad">Couldn't run: {failed.join(", ")}. A zero count for these means unchecked.</p>
      {/if}
    </section>

    {#if issues.length === 0}
      <p class="it-note">{noneText}</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th class="fit">Kind</th>
            {@render head()}
          </tr>
        </thead>
        <tbody>
          {#each issues as issue (issue.key)}
            <tr
              class="issue-row"
              class:selected={issue.key === selectedKey}
              tabindex="0"
              title={issue.reason}
              onclick={() => onIssueClick(issue)}
              onkeydown={(e) => e.key === "Enter" && onIssueClick(issue)}
            >
              <td class="fit kind {issue.severity}">{issue.kind}</td>
              {@render cells(issue)}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .it-pane {
    height: 100%;
    overflow: auto;
  }
  .summary {
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    color: var(--hdx-neutral-8);
    border-bottom: 1px solid var(--hdx-neutral-1);
  }
  .summary p {
    margin: 0 0 0.3rem;
  }
  .summary p.bad {
    color: var(--hdx-error-6);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead {
    background: var(--hdx-neutral-05);
  }
  table :global(th),
  table :global(td) {
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--hdx-neutral-1);
    white-space: nowrap;
  }
  th:first-child,
  td:first-child {
    padding-left: 0.75rem;
  }
  table :global(th) {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--hdx-neutral-7);
  }
  table :global(.fit) {
    width: 1%;
  }
  /* max-width: 0 stops cell content from widening the column, so it truncates instead. */
  table :global(.flex) {
    width: 50%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  table :global(td.value) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  table :global(.muted) {
    color: var(--hdx-neutral-6);
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
  td.kind.error {
    color: var(--hdx-error-6);
  }
  td.kind.warn {
    color: var(--hdx-warning-6);
  }
  .it-note {
    margin: 0;
    padding: 0.75rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
  }
  .it-empty {
    padding: 1rem;
    text-align: center;
    color: var(--hdx-neutral-7);
    font-size: 0.875rem;
  }
</style>
