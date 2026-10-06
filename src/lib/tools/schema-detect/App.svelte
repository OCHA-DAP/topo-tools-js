<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { findingInfo } from "$lib/components/MapPopup.svelte";
  import { runSchemaDetect, type SchemaResult } from "./pipeline/index";
  import SchemaTable from "./SchemaTable.svelte";

  function describe(result: SchemaResult, key: string) {
    const i = result.issues.find((x) => x.key === key);
    if (!i) return null;
    return findingInfo(i, [
      ["Level", i.level?.toString() ?? ""],
      ["Column", i.column ?? ""],
      ["Code", i.code ?? ""],
    ]);
  }
</script>

<CheckApp
  slug="schema-detect"
  title="Schema Detect"
  blurb="Check a layer's admin-hierarchy columns: undetectable or skipped levels, column names unlike their match at other levels, levels missing a column the others have, and units with several parents or none, without changing anything."
  run={(conn, schema) => runSchemaDetect(conn, schema)}
  downloads={[{ label: "Download Issues CSV", source: "schema_detect_issues" }]}
  {describe}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <SchemaTable {result} {selectedKey} {emptyText} {select} />
  {/snippet}
</CheckApp>
