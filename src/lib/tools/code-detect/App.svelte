<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { runCodeDetect } from "./pipeline/index";
  import CodeTable from "./CodeTable.svelte";
</script>

<CheckApp
  slug="code-detect"
  title="Code Detect"
  blurb="Check a coded layer's unit codes for blanks, conflicting names, duplicates, split units, codes that don't start with their parent's, and format outliers, without changing anything."
  run={(conn, schema) => runCodeDetect(conn, schema)}
  downloads={[{ label: "Download Issues CSV", source: "code_detect_issues" }]}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <CodeTable {result} {selectedKey} {emptyText} {select} />
  {/snippet}
</CheckApp>
