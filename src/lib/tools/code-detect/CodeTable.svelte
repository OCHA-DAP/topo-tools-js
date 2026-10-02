<script lang="ts">
  import IssueTable from "$lib/components/IssueTable.svelte";
  import type { CodeResult } from "./pipeline/index";

  let {
    result,
    selectedKey,
    emptyText,
    select,
  }: {
    result: CodeResult | null;
    selectedKey: string | null;
    emptyText: string;
    select: (key: string) => void;
  } = $props();
</script>

<IssueTable
  issues={result?.issues ?? null}
  failed={result?.failed ?? []}
  {selectedKey}
  {emptyText}
  noneText="No code issues found."
  onIssueClick={(issue) => select(issue.key)}
>
  {#snippet head()}
    <th class="fit">Level</th>
    <th class="fit">Code</th>
    <th class="flex">Detail</th>
  {/snippet}
  {#snippet cells(issue)}
    <td class="fit">{issue.level}</td>
    <td class="fit value">{issue.codeA ?? issue.column}</td>
    <td class="flex"><span class="muted">{issue.reason}</span></td>
  {/snippet}
</IssueTable>
