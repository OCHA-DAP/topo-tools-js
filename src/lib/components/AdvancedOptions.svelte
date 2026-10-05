<script lang="ts">
  import type { Snippet } from "svelte";

  let { open = $bindable(false), children }: { open?: boolean; children: Snippet } = $props();
</script>

<details class="advanced" bind:open>
  <summary>Advanced options</summary>
  <div class="body">
    {@render children()}
  </div>
</details>

<style>
  .advanced {
    padding-top: 0.75rem;
    border-top: 1px solid var(--hdx-neutral-1);
  }

  summary {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
    cursor: pointer;
    user-select: none;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    margin-top: 0.75rem;
  }

  .body :global(h3) {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--hdx-neutral-8);
    margin: 0 0 0.4rem;
  }
</style>
