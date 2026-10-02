<script lang="ts">
  import type { NameIssueKind, NameIssueRow } from "./pipeline/index";

  let {
    issues,
    failed,
    clean,
    selectedKey,
    emptyText,
    onIssueClick,
  }: {
    issues: NameIssueRow[] | null;
    failed: NameIssueKind[];
    clean: boolean;
    selectedKey: string | null;
    emptyText: string;
    onIssueClick: (issue: NameIssueRow) => void;
  } = $props();

  const errors = $derived(issues?.filter((i) => i.severity === "error").length ?? 0);
  const warnings = $derived(issues?.filter((i) => i.severity === "warn").length ?? 0);
  const fixed = $derived(issues?.filter((i) => i.fixed).length ?? 0);

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // Spaces and invisible characters a reviewer can't see are shown as markers.
  function visible(s: string | null): string {
    if (s === null) return "";
    return s
      .replace(/[\u0000-\u001f\u007f-\u00a0\u00ad\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]/g, (c) =>
        c === " " ? c : `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
      )
      .replace(/^ | $/g, "␣")
      .replace(/ {2,}/g, (m) => "␣".repeat(m.length));
  }
</script>

<div class="nt-pane">
  {#if !issues}
    <p class="nt-empty">{emptyText}</p>
  {:else}
    <section class="summary">
      <p>
        <strong>{plural(issues.length, "finding", "findings")}</strong>:
        {plural(errors, "error", "errors")}, {plural(warnings, "warning", "warnings")}{#if clean}, {fixed} fixed{/if}.
      </p>
      {#if failed.length > 0}
        <p class="bad">Couldn't run: {failed.join(", ")}. A zero count for these means unchecked.</p>
      {/if}
    </section>

    {#if issues.length === 0}
      <p class="nt-note">No name issues found.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th class="fit">Kind</th>
            <th class="fit">Code</th>
            <th class="flex">Name</th>
            <th class="flex">{clean ? "Fixed to" : "Suggested"}</th>
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
              <td class="fit value">{issue.codeA ?? `${issue.nameColumn}`}</td>
              <td class="flex value">
                {#if issue.codeA === null}
                  <span class="muted">{issue.reason}</span>
                {:else}
                  {visible(issue.nameA)}{#if issue.nameB !== null && issue.nameB !== issue.nameA}
                    <span class="muted"> / {visible(issue.nameB)}</span>{/if}
                {/if}
              </td>
              <td class="flex value">
                {#if clean && !issue.fixed}
                  <span class="muted">left for review</span>
                {:else}
                  {visible(issue.suggested)}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .nt-pane {
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
    width: 50%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  td.value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .muted {
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
  .nt-note {
    margin: 0;
    padding: 0.75rem;
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
  }
  .nt-empty {
    padding: 1rem;
    text-align: center;
    color: var(--hdx-neutral-7);
    font-size: 0.875rem;
  }
</style>
