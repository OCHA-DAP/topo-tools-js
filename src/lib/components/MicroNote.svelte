<script lang="ts">
  let { count }: { count: number } = $props();
</script>

{count} sliver{count === 1 ? " was" : "s were"} too thin to keep and merged into a neighbour or dropped.
