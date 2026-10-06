<script lang="ts">
  import SideToggle from "$lib/components/SideToggle.svelte";
  import { untrack } from "svelte";
  import CrosswalkTable from "./CrosswalkTable.svelte";
  import MapView from "./MapView.svelte";
  import { REL_ORDER, type RelClass, type TableRow } from "./pipeline";

  let {
    overlayGeojson,
    outlineAGeojson,
    outlineBGeojson,
    tableRows,
    bounds,
    processing,
    sideLabels = ["Version A", "Version B"],
    classes = REL_ORDER,
    showSide = $bindable("b"),
    selectedClusterId = $bindable(null),
  }: {
    overlayGeojson: string | null;
    outlineAGeojson: string | null;
    outlineBGeojson: string | null;
    tableRows: TableRow[];
    bounds: [number, number, number, number] | null;
    processing: boolean;
    sideLabels?: [string, string];
    classes?: RelClass[];
    showSide?: "a" | "b";
    selectedClusterId?: number | null;
  } = $props();

  let hoveredClusterId = $state<number | null>(null);
  let hoveredFid = $state<number | null>(null);
  // The hovered row's both-side fids, set by map or table hover, so a side
  // toggle re-derives hoveredFid for the same logical row without a flash.
  let hoveredRow = $state<{
    cluster_id: number;
    a_fid: number | null;
    b_fid: number | null;
  } | null>(null);
  let visibleClasses = $state<Set<RelClass>>(new Set(REL_ORDER));

  function toggleClass(c: RelClass): void {
    const next = new Set(visibleClasses);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    visibleClasses = next;
  }

  function setHoveredFromMap(payload: { cluster_id: number | null; fid: number | null }): void {
    hoveredClusterId = payload.cluster_id;
    hoveredFid = payload.fid;
    if (payload.cluster_id == null || payload.fid == null) {
      hoveredRow = null;
      return;
    }
    let found: { cluster_id: number; a_fid: number | null; b_fid: number | null } | null = null;
    for (const r of tableRows) {
      if (r.cluster_id !== payload.cluster_id) continue;
      const matches = showSide === "a" ? r.a_fid === payload.fid : r.b_fid === payload.fid;
      if (matches) {
        found = { cluster_id: r.cluster_id, a_fid: r.a_fid, b_fid: r.b_fid };
        break;
      }
    }
    hoveredRow = found;
  }

  function setHoveredFromRow(
    payload: { cluster_id: number | null; a_fid: number | null; b_fid: number | null } | null,
  ): void {
    if (payload == null || payload.cluster_id == null) {
      hoveredRow = null;
      hoveredClusterId = null;
      hoveredFid = null;
      return;
    }
    hoveredRow = { cluster_id: payload.cluster_id, a_fid: payload.a_fid, b_fid: payload.b_fid };
    hoveredClusterId = payload.cluster_id;
    hoveredFid = showSide === "a" ? payload.a_fid : payload.b_fid;
  }

  $effect(() => {
    const side = showSide;
    const row = hoveredRow;
    if (row == null) return;
    untrack(() => {
      hoveredFid = side === "a" ? row.a_fid : row.b_fid;
    });
  });
</script>

<div class="cw-result">
  <div class="cw-map-pane">
    {#if overlayGeojson}
      <SideToggle bind:side={showSide} labels={sideLabels} />
    {/if}

    <MapView
      {overlayGeojson}
      {outlineAGeojson}
      {outlineBGeojson}
      {bounds}
      {processing}
      {hoveredClusterId}
      {hoveredFid}
      {visibleClasses}
      onClusterClick={(id) => (selectedClusterId = id)}
      onFeatureHover={setHoveredFromMap}
      {showSide}
    />
  </div>
  <div class="cw-table-pane">
    <CrosswalkTable
      rows={tableRows}
      {selectedClusterId}
      {hoveredClusterId}
      {hoveredFid}
      {showSide}
      {visibleClasses}
      {sideLabels}
      {classes}
      onRowHover={setHoveredFromRow}
      onToggleClass={toggleClass}
      onSetSide={(side) => (showSide = side)}
    />
  </div>
</div>

<style>
  .cw-result {
    display: grid;
    grid-template-rows: 65% 35%;
    height: 100dvh;
    min-width: 0;
  }
  .cw-map-pane {
    min-height: 0;
    border-bottom: 1px solid var(--hdx-neutral-1);
    position: relative;
  }

  .cw-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .cw-result {
      grid-template-rows: 1fr;
      grid-template-columns: 65% 35%;
    }
    .cw-map-pane {
      border-right: 1px solid var(--hdx-neutral-1);
      border-bottom: none;
    }
  }
</style>
