<script lang="ts">
  import { onMount } from "svelte";
  import SegmentedControl from "./SegmentedControl.svelte";

  let {
    side = $bindable(),
    labels,
    disabled = false,
  }: {
    side: "a" | "b";
    labels: [string, string];
    disabled?: boolean;
  } = $props();

  function handleKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (disabled || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "]" || e.key === "[") side = side === "a" ? "b" : "a";
  }

  onMount(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });
</script>

<div class="toolbar">
  <SegmentedControl
    bind:value={side}
    options={[
      { value: "a", label: labels[0] },
      { value: "b", label: labels[1] },
    ]}
    label="View mode"
    {disabled}
  />
  <p class="hint"><kbd>[</kbd><kbd>]</kbd> to cycle</p>
</div>

<style>
  .toolbar {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }
  .toolbar :global(.segmented) {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .hint {
    margin: 0;
    font-size: 0.7rem;
    color: var(--hdx-neutral-7);
    background: var(--hdx-neutral-0);
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-md);
    padding: 0.2rem 0.45rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .hint kbd {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-sm);
    background: var(--hdx-neutral-05);
    color: var(--hdx-neutral-7);
  }
</style>
