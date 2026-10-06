<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { findingInfo } from "$lib/components/MapPopup.svelte";
  import { runCodeDetect, type CodeResult } from "./pipeline/index";
  import CodeTable from "./CodeTable.svelte";

  function describe(result: CodeResult, key: string) {
    const i = result.issues.find((x) => x.key === key);
    if (!i) return null;
    return findingInfo(i, [
      ["Level", i.level?.toString() ?? ""],
      ["Code", i.codeA ?? i.column ?? ""],
      ["Name", i.nameA ?? ""],
      ["Other code", i.codeB ?? ""],
      ["Other name", i.nameB ?? ""],
    ]);
  }
</script>

<CheckApp
  slug="code-detect"
  title="Code Detect"
  blurb="Check a coded layer's unit codes for blanks, conflicting names, duplicates, split units, codes that don't start with their parent's, and format outliers, without changing anything."
  run={(conn, schema) => runCodeDetect(conn, schema)}
  downloads={[{ label: "Download Issues CSV", source: "code_detect_issues" }]}
  {describe}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <CodeTable {result} {selectedKey} {emptyText} {select} />
  {/snippet}
</CheckApp>
