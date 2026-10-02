<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { runSchemaDetect } from "./pipeline/index";
  import SchemaTable from "./SchemaTable.svelte";
</script>

<CheckApp
  slug="schema-detect"
  title="Schema Detect"
  blurb="Check a layer's admin-hierarchy columns: undetectable or skipped levels, column names unlike their match at other levels, levels missing a column the others have, and units with several parents or none, without changing anything."
  run={(conn, schema) => runSchemaDetect(conn, schema)}
  downloads={[{ label: "Download Issues CSV", source: "schema_detect_issues" }]}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <SchemaTable {result} {selectedKey} {emptyText} {select} />
  {/snippet}
</CheckApp>
