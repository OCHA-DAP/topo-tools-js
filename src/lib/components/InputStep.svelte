<script lang="ts">
  import type { Snippet } from "svelte";

  // A tool's inputs; multi-input tools pass `collapsed` to fold them into their heading once a result arrives.
  let {
    title,
    collapsed,
    detail = "",
    children,
  }: { title: string; collapsed?: boolean; detail?: string; children: Snippet } = $props();

  let open = $state(true);
  $effect(() => {
    if (collapsed) open = false;
  });
</script>

{#if collapsed === undefined}
  <section class="input-step">
    <h2 class="title">{title}</h2>
    <div class="body">
      {@render children()}
    </div>
  </section>
{:else}
  <details class="input-step" bind:open>
    <summary>
      <span class="title">{title}</span>
      {#if !open && detail}<span class="detail">{detail}</span>{/if}
    </summary>
    <div class="body">
      {@render children()}
    </div>
  </details>
{/if}

<style>
  summary {
    cursor: pointer;
    user-select: none;
  }

  .title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--hdx-neutral-9);
    margin: 0;
  }

  .detail {
    display: inline-block;
    max-width: calc(100% - 5rem);
    margin-left: 0.5rem;
    vertical-align: bottom;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--hdx-neutral-7);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-top: 0.6rem;
  }

  .body :global(h3) {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--hdx-neutral-8);
    margin: 0.2rem 0 -0.2rem;
  }
</style>
