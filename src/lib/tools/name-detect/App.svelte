<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { runNameClean } from "$lib/tools/name-clean/pipeline/index";
  import { runNameDetect } from "./pipeline/index";
  import NameTable from "./NameTable.svelte";

  // Name Clean is Name Detect plus the safe fixes, so both pages share this app.
  let { clean = false }: { clean?: boolean } = $props();
</script>

<CheckApp
  slug={clean ? "name-clean" : "name-detect"}
  title={clean ? "Name Clean" : "Name Detect"}
  blurb={clean
    ? "Check a coded layer's unit names and fix only what can't change a name's meaning: spacing, invisible characters, Unicode normalization and certain encoding repairs. Case, spelling and duplicates are left for review."
    : "Check a coded layer's unit names for blanks, placeholders, duplicates, encoding errors, invisible characters and case outliers, without changing anything."}
  run={clean ? runNameClean : runNameDetect}
  downloads={clean
    ? [
        { label: "Download GeoJSON", source: "name_clean" },
        { label: "Download Issues CSV", source: "name_clean_issues" },
      ]
    : [{ label: "Download Issues CSV", source: "name_detect_issues" }]}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <NameTable
      issues={result?.issues ?? null}
      failed={result?.failed ?? []}
      {clean}
      {selectedKey}
      {emptyText}
      onIssueClick={(issue) => select(issue.key)}
    />
  {/snippet}
</CheckApp>
