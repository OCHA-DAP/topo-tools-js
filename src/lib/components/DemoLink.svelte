<script lang="ts">
  import { tools } from "$lib/tools";

  let { slug }: { slug: string } = $props();

  const demo = tools.find((t) => t.slug === slug)?.demo;
</script>

{#if demo}
  <a class="demo-link" href={`?${new URLSearchParams(demo)}`}>
    <span aria-hidden="true">▶</span> Try with demo data
  </a>
{/if}

<style>
  .demo-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid #c4b5fd;
    border-radius: 6px;
    background: #f5f3ff;
    color: #6d28d9;
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
  }

  .demo-link:hover {
    background: #ede9fe;
    border-color: #a78bfa;
  }

  .demo-link span {
    font-size: 0.65rem;
  }
</style>
