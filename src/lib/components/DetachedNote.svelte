<script lang="ts">
  let { merged, kept }: { merged: number; kept: number } = $props();
</script>

{#if merged > 0}
  {merged} small clip-detached piece{merged === 1 ? "" : "s"} merged into the neighbouring feature
  sharing the longest edge{kept > 0 ? ";" : "."}
{/if}
{#if kept > 0}
  {kept} detached piece{kept === 1 ? "" : "s"} kept as drawn, see the issues download for why.
{/if}
