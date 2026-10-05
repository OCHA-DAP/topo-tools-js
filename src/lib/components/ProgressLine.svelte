<script lang="ts">
  let { label }: { label: string } = $props();
</script>

<p class="progress-line" role="status">
  <span class="dot"></span>
  {label}
</p>

<style>
  .progress-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--hdx-primary-5);
    animation: pulse 1s ease-in-out infinite;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
</style>
