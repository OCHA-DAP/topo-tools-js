<script lang="ts" generics="T extends string">
  let {
    value = $bindable(),
    options,
    label,
    disabled = false,
  }: {
    value: T | null;
    options: { value: T; label: string }[];
    label: string;
    disabled?: boolean;
  } = $props();
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      class="btn"
      class:active={value === opt.value}
      {disabled}
      onclick={() => (value = opt.value)}>{opt.label}</button
    >
  {/each}
</div>

<style>
  .segmented {
    display: flex;
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-md);
    overflow: hidden;
    background: var(--hdx-neutral-0);
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
    background: var(--hdx-neutral-0);
    color: var(--hdx-neutral-7);
    cursor: pointer;
    border-left: 1px solid var(--hdx-neutral-1);
    text-align: center;
  }
  .btn:first-child {
    border-left: none;
  }
  .btn:hover:not(:disabled) {
    background: var(--hdx-neutral-05);
    color: var(--hdx-neutral-8);
  }
  .btn.active {
    background: var(--hdx-primary-5);
    color: var(--hdx-neutral-0);
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
