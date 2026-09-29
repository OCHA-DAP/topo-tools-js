<script lang="ts">
  interface Props {
    overlayColumns: string[];
    inputColumns: string[];
    selected: string[];
    disabled?: boolean;
  }

  let { overlayColumns, inputColumns, selected = $bindable(), disabled = false }: Props = $props();
</script>

<div class="carry-cols">
  {#each overlayColumns as col (col)}
    <label class="carry-field">
      <input
        type="checkbox"
        checked={selected.includes(col)}
        disabled={disabled || inputColumns.includes(col)}
        onchange={(e) => {
          const checked = (e.target as HTMLInputElement).checked;
          selected = checked ? [...selected, col] : selected.filter((c) => c !== col);
        }}
      />
      <span>{col}</span>
    </label>
  {/each}
</div>

<style>
  .carry-cols {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 8rem;
    overflow-y: auto;
  }

  .carry-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #374151;
  }
</style>
