<script lang="ts">
  import IssueTable from "$lib/components/IssueTable.svelte";
  import type { NameIssueRow } from "./pipeline/index";
  import { visible } from "./visible";

  let {
    issues,
    clean,
    selectedKey,
    emptyText,
    onIssueClick,
  }: {
    issues: NameIssueRow[] | null;
    clean: boolean;
    selectedKey: string | null;
    emptyText: string;
    onIssueClick: (issue: NameIssueRow) => void;
  } = $props();

  const fixed = $derived(issues?.filter((i) => i.fixed).length ?? 0);
</script>

<IssueTable
  {issues}
  {selectedKey}
  {emptyText}
  noneText="No name issues found."
  extra={clean ? `, ${fixed} fixed` : ""}
  {onIssueClick}
>
  {#snippet head()}
    <th class="fit">Code</th>
    <th class="flex">Name</th>
    <th class="flex">{clean ? "Fixed to" : "Suggested"}</th>
  {/snippet}
  {#snippet cells(issue)}
    <td class="fit value">{issue.codeA ?? issue.nameColumn ?? ""}</td>
    <td
      class="flex value"
      title={issue.codeA === null
        ? issue.reason
        : visible(issue.nameA) +
          (issue.nameB !== null && issue.nameB !== issue.nameA ? ` / ${visible(issue.nameB)}` : "")}
    >
      {#if issue.codeA === null}
        <span class="muted">{issue.reason}</span>
      {:else}
        {visible(issue.nameA)}{#if issue.nameB !== null && issue.nameB !== issue.nameA}
          <span class="muted"> / {visible(issue.nameB)}</span>{/if}
      {/if}
    </td>
    <td class="flex value" title={clean && !issue.fixed ? issue.reason : visible(issue.suggested) || undefined}>
      {#if clean && !issue.fixed}
        <span class="muted">left for review</span>
      {:else}
        {visible(issue.suggested)}
      {/if}
    </td>
  {/snippet}
</IssueTable>
