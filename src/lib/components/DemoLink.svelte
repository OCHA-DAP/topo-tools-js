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
    border: 1px solid var(--hdx-primary-5);
    border-radius: var(--hdx-radius-sm);
    background: var(--hdx-neutral-0);
    color: var(--hdx-primary-7);
    box-shadow: var(--hdx-shadow-sm);
    font-size: 0.8rem;
    font-weight: 500;
    text-decoration: none;
  }

  .demo-link:hover {
    border-color: var(--hdx-primary-7);
    box-shadow: none;
  }

  .demo-link span {
    font-size: 0.65rem;
  }
</style>
