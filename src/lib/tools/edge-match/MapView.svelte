<script lang="ts">
  import type {
    ExpressionSpecification,
    FilterSpecification,
    GeoJSONSource,
    Map as MaplibreMap,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { MAP_COLORS, MAP_FILL_OPACITY } from "$lib/utils/mapColors";
  import { loadMaplibre, loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";

  let {
    resultGeojson = null,
    inputGeojson = null,
    streamGeojson = null,
    overlayOutlineGeojson = null,
    activeOverlayFid = null,
    replacedGroupIds = [],
    showSide = "b",
    bounds = null,
    processing = false,
  }: {
    resultGeojson?: string | null;
    inputGeojson?: string | null;
    // Groups finished so far in a running match, replaced by resultGeojson at the end.
    streamGeojson?: string | null;
    overlayOutlineGeojson?: string | null;
    activeOverlayFid?: number | null;
    // Groups whose input features are hidden because their streamed result covers them.
    replacedGroupIds?: number[];
    showSide?: "a" | "b";
    bounds?: [number, number, number, number] | null;
    processing?: boolean;
  } = $props();

  // Cycled by group_id, since the group count is only known once the overlay loads.
  const PALETTE = [
    "#4e79a7",
    "#f28e2b",
    "#e15759",
    "#76b7b2",
    "#59a14f",
    "#edc948",
    "#b07aa1",
    "#ff9da7",
    "#9c755f",
    "#bab0ac",
  ];
  const EMPTY = JSON.stringify({ type: "FeatureCollection", features: [] });
  // Everything else is inserted below this, so the reference boundary stays on top.
  const TOP = "eg-overlay-line";

  let container: HTMLDivElement | undefined;
  let map = $state.raw<MaplibreMap | undefined>();
  let styleReady = $state(false);
  const urls: Record<string, string> = {};
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  $effect(() => {
    if (processing) stopSpin();
  });

  function fillColorExpr(): ExpressionSpecification {
    const paletteIndex = ["%", ["get", "group_id"], PALETTE.length];
    return [
      "match",
      paletteIndex,
      ...PALETTE.flatMap((c, i) => [i, c]),
      "#cccccc",
    ] as unknown as ExpressionSpecification;
  }

  // Returns true when the source is new, so the caller adds its layers.
  function upsertSource(id: string, data: string): boolean {
    if (!map) return false;
    if (urls[id]) URL.revokeObjectURL(urls[id]);
    urls[id] = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) {
      src.setData(urls[id]);
      return false;
    }
    map.addSource(id, { type: "geojson", data: urls[id] });
    return true;
  }

  function below(): string | undefined {
    return map?.getLayer(TOP) ? TOP : undefined;
  }

  function addPolygonLayers(source: string, fill: ExpressionSpecification | string): void {
    map!.addLayer(
      { id: `${source}-fill`, type: "fill", source, filter: polyFilter, paint: { "fill-color": fill, "fill-opacity": MAP_FILL_OPACITY } },
      below(),
    );
    map!.addLayer(
      { id: `${source}-line`, type: "line", source, filter: polyFilter, paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": lineWidth } },
      below(),
    );
  }

  // While running, the input shows underneath the streamed groups regardless of side.
  function applySide(): void {
    if (!map) return;
    const visible = {
      "eg-input": showSide === "a" || processing,
      "eg-result": showSide === "b",
      "eg-stream": showSide === "b" || processing,
    };
    for (const [source, on] of Object.entries(visible)) {
      for (const layer of [`${source}-fill`, `${source}-line`]) {
        if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
      }
    }
  }

  $effect(() => {
    const b = bounds;
    if (!b || !map || !styleReady) return;
    stopSpin();
    map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: 40, animate: true },
    );
  });

  $effect(() => {
    const data = overlayOutlineGeojson;
    if (!data || !map || !styleReady) return;
    if (upsertSource("eg-overlay", data)) {
      map.addLayer({
        id: TOP,
        type: "line",
        source: "eg-overlay",
        paint: { "line-color": MAP_COLORS.outline, "line-width": lineWidth, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: "eg-active-line",
        type: "line",
        source: "eg-overlay",
        filter: ["==", ["get", "fid"], activeOverlayFid ?? -2],
        paint: { "line-color": MAP_COLORS.selected, "line-width": 3 },
      });
    }
  });

  $effect(() => {
    const fid = activeOverlayFid;
    if (!map || !styleReady || !map.getLayer("eg-active-line")) return;
    map.setFilter("eg-active-line", ["==", ["get", "fid"], fid ?? -2]);
  });

  // null clears a source that already exists, so a rerun doesn't show the last run's layers.
  function syncPolygons(source: string, data: string | null, fill: ExpressionSpecification | string): void {
    if (!map || !styleReady || (!data && !map.getSource(source))) return;
    if (upsertSource(source, data ?? EMPTY)) addPolygonLayers(source, fill);
    applySide();
    applyReplaced();
  }

  $effect(() => syncPolygons("eg-input", inputGeojson, MAP_COLORS.original));
  $effect(() => syncPolygons("eg-stream", streamGeojson, fillColorExpr()));
  $effect(() => syncPolygons("eg-result", resultGeojson, fillColorExpr()));

  $effect(() => {
    const _side = showSide;
    const _running = processing;
    if (map && styleReady) applySide();
  });

  function applyReplaced(): void {
    if (!map) return;
    const filter = (
      replacedGroupIds.length === 0
        ? polyFilter
        : ["all", polyFilter, ["!", ["in", ["get", "group_id"], ["literal", replacedGroupIds]]]]
    ) as FilterSpecification;
    for (const layer of ["eg-input-fill", "eg-input-line"]) {
      if (map.getLayer(layer)) map.setFilter(layer, filter);
    }
  }

  $effect(() => {
    const _ids = replacedGroupIds;
    if (map && styleReady) applyReplaced();
  });

  onMount(async () => {
    if (!container) return;
    const maplibregl = await loadMaplibre();
    const style = await loadStyle();
    map = new maplibregl.Map({
      container,
      style,
      center: [20, 5],
      zoom: Math.log2((Math.min(container.clientWidth, container.clientHeight) * Math.PI) / 512),
      attributionControl: { compact: true },
    });
    map.once("load", () => {
      styleReady = true;
      startSpin();
      map?.on("mousedown", stopSpin);
      map?.on("touchstart", stopSpin);
      map?.on("wheel", stopSpin);
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    for (const url of Object.values(urls)) URL.revokeObjectURL(url);
  });
</script>

<div bind:this={container} class="eg-map"></div>

<style>
  .eg-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
</style>
