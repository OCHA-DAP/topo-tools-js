<script lang="ts">
  import IssueTable from "$lib/components/IssueTable.svelte";
  import type { NameIssueRow } from "./pipeline/index";

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
  {/snippet}
</IssueTable>
