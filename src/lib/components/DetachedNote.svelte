<script lang="ts">
  let { merged, kept }: { merged: number; kept: number } = $props();
</script>

{#if merged > 0}
  {merged} small piece{merged === 1 ? "" : "s"} cut off by the clip merged into a neighbour{kept > 0 ? ";" : "."}
{/if}
{#if kept > 0}
  {kept} cut-off piece{kept === 1 ? " was" : "s were"} kept, see the issues download.
{/if}
