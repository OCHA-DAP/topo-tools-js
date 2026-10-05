<script lang="ts">
  let { count }: { count: number } = $props();
</script>

{count} automatic cleanup{count === 1 ? "" : "s"}, details in the issues.
