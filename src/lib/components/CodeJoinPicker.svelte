<script lang="ts">
  interface Props {
    inputColumns: string[];
    overlayColumns: string[];
    inputValue: string | null;
    overlayValue: string | null;
    hint: string;
    disabled?: boolean;
  }

  let {
    inputColumns,
    overlayColumns,
    inputValue = $bindable(),
    overlayValue = $bindable(),
    hint,
    disabled = false,
  }: Props = $props();
</script>

<div class="code-join">
  <h3>Code join</h3>
  <p class="hint">{hint}</p>
  <label class="match-field">
    <span>Input code</span>
    <select bind:value={inputValue} {disabled}>
      <option value={null}>(none)</option>
      {#each inputColumns as col (col)}<option value={col}>{col}</option>{/each}
    </select>
  </label>
  <label class="match-field">
    <span>Overlay code</span>
    <select bind:value={overlayValue} {disabled}>
      <option value={null}>(none)</option>
      {#each overlayColumns as col (col)}<option value={col}>{col}</option>{/each}
    </select>
  </label>
</div>

<style>
  .code-join {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--hdx-neutral-7);
    margin: 0 0 0.2rem;
    line-height: 1.4;
  }

  .match-field {
    display: grid;
    grid-template-columns: 90px 1fr;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }

  .match-field select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid var(--hdx-neutral-2);
    border-radius: var(--hdx-radius-sm);
    background: var(--hdx-neutral-0);
  }
</style>
