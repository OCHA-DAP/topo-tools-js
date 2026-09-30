<script lang="ts">
  import { onMount } from "svelte";

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
  <div class="btns" role="group" aria-label="View mode">
    <button class="btn" class:active={side === "a"} {disabled} onclick={() => (side = "a")}>{labels[0]}</button>
    <button class="btn" class:active={side === "b"} {disabled} onclick={() => (side = "b")}>{labels[1]}</button>
  </div>
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
  .btns {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .btn {
    appearance: none;
    -webkit-appearance: none;
    flex: 1 1 0;
    padding: 0.3rem 0.6rem;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
    border-left: 1px solid #e5e7eb;
    text-align: center;
  }
  .btn:first-child {
    border-left: none;
  }
  .btn:hover:not(:disabled) {
    background: #f3f4f6;
    color: #374151;
  }
  .btn.active {
    background: #374151;
    color: #fff;
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .hint {
    margin: 0;
    font-size: 0.7rem;
    color: #6b7280;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.2rem 0.45rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .hint kbd {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f3f4f6;
    color: #4b5563;
  }
</style>
