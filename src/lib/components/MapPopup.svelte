<script lang="ts" module>
  // One hovered feature's details: a title with a color swatch, an optional tag, label/value rows and a note.
  export interface FeatureInfo {
    title: string;
    tag?: string;
    tone?: string;
    fields: Array<[label: string, value: string]>;
    note?: string;
  }

  const SEVERITY_TONE: Record<string, string> = {
    error: "var(--hdx-error-6)",
    warn: "var(--hdx-warning-6)",
  };

  // A report finding as popup content, titled by its kind and toned by its severity.
  export function findingInfo(
    finding: { kind: string; severity: string; reason?: string | null },
    fields: FeatureInfo["fields"],
  ): FeatureInfo {
    return {
      title: finding.kind,
      tag: finding.severity === "warn" ? "warning" : finding.severity,
      tone: SEVERITY_TONE[finding.severity],
      fields: fields.filter(([, value]) => value !== ""),
      note: finding.reason ?? undefined,
    };
  }
</script>

<script lang="ts">
  import { loadMaplibre } from "$lib/utils/mapStyle";
  import type { LngLatLike, Map as MaplibreMap, Popup } from "maplibre-gl";
  import { onDestroy, onMount } from "svelte";

  // Hover popup for a MapLibre map; shown while `items` is non-empty and `lngLat` set.
  let {
    getMap,
    items,
    lngLat,
  }: {
    getMap: () => MaplibreMap | undefined;
    items: FeatureInfo[];
    lngLat: LngLatLike | null;
  } = $props();

  let el: HTMLDivElement | undefined;
  let popup = $state<Popup | undefined>();

  onMount(async () => {
    const maplibregl = await loadMaplibre();
    popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "360px" }).setDOMContent(el!);
  });

  $effect(() => {
    const show = items.length > 0 && lngLat !== null;
    const map = getMap();
    if (!popup || !map) return;
    if (show) popup.setLngLat(lngLat!).addTo(map);
    else popup.remove();
  });

  onDestroy(() => popup?.remove());
</script>

<div hidden>
  <div bind:this={el} class="map-popup">
    {#each items as info, i (i)}
      <div class="item">
        <div class="head">
          <span class="title">
            {#if info.tone}<span class="swatch" style:background={info.tone}></span>{/if}{info.title}
          </span>
          {#if info.tag}<span class="tag" style:color={info.tone}>{info.tag}</span>{/if}
        </div>
        {#if info.fields.length > 0}
          <dl>
            {#each info.fields as [label, value], j (j)}
              <dt>{label}</dt>
              <dd>{value}</dd>
            {/each}
          </dl>
        {/if}
        {#if info.note}<p class="note">{info.note}</p>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .map-popup {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--hdx-neutral-9);
  }
  .item + .item {
    padding-top: 0.6rem;
    border-top: 1px solid var(--hdx-neutral-1);
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.3rem;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
  }
  .swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .tag {
    font-size: 0.7rem;
    text-transform: uppercase;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0;
  }
  dt {
    color: var(--hdx-neutral-7);
  }
  dd {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }
  .note {
    margin: 0.4rem 0 0;
    padding-top: 0.4rem;
    border-top: 1px solid var(--hdx-neutral-1);
    color: var(--hdx-neutral-7);
  }
</style>
