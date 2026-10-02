<script lang="ts">
  import IssueTable from "$lib/components/IssueTable.svelte";
  import type { SchemaResult } from "./pipeline/index";

  let {
    result,
    selectedKey,
    emptyText,
    select,
  }: {
    result: SchemaResult | null;
    selectedKey: string | null;
    emptyText: string;
    select: (key: string) => void;
  } = $props();
</script>

<IssueTable
  issues={result?.issues ?? null}
  {selectedKey}
  {emptyText}
  noneText="No schema issues found."
  onIssueClick={(issue) => select(issue.key)}
>
  {#snippet head()}
    <th class="fit">Level</th>
    <th class="fit">Column</th>
    <th class="flex">Detail</th>
  {/snippet}
  {#snippet cells(issue)}
    <td class="fit">{issue.level ?? ""}</td>
    <td class="fit value">{issue.code ?? issue.column ?? ""}</td>
    <td class="flex"><span class="muted">{issue.reason}</span></td>
  {/snippet}
</IssueTable>
