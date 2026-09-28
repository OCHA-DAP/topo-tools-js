<script lang="ts">
  import type { Snippet } from "svelte";

  let { map, table }: { map: Snippet; table: Snippet } = $props();
</script>

<div class="split">
  <div class="map-pane">{@render map()}</div>
  <div class="table-pane">{@render table()}</div>
</div>

<style>
  .split {
    display: grid;
    grid-template-rows: 65% 35%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background: #fff;
  }

  .map-pane {
    min-height: 0;
    position: relative;
    border-bottom: 1px solid #e5e7eb;
  }

  .table-pane {
    min-height: 0;
    overflow: hidden;
  }

  @media (min-width: 1280px) {
    .split {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr minmax(30rem, 35%);
    }
    .map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
</style>
