<script lang="ts">
  import type {
    ExpressionSpecification,
    GeoJSONSource,
    Map as MaplibreMap,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { loadMaplibre, loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";

  let {
    resultGeojson = null,
    parentOutlineGeojson = null,
    bounds = null,
    processing = false,
  }: {
    resultGeojson?: string | null;
    parentOutlineGeojson?: string | null;
    bounds?: [number, number, number, number] | null;
    processing?: boolean;
  } = $props();

  // Categorical palette cycled by group_id — group count is dynamic (unknown
  // until the parent layer is loaded), unlike a fixed set of relationship
  // classes, so stops are generated at runtime from the distinct group_ids
  // actually present in the result rather than a hardcoded list.
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

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let resultUrl: string | undefined;
  let outlineUrl: string | undefined;
  let styleReady = false;
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

  function setSource(id: string, dataUrl: string): void {
    if (!map) return;
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(dataUrl);
  }

  $effect(() => {
    const b = bounds;
    if (!b || !map) return;
    function apply() {
      if (!map || !b) return;
      const [minLng, minLat, maxLng, maxLat] = b;
      stopSpin();
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 40, animate: true },
      );
    }
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  });

  $effect(() => {
    const data = parentOutlineGeojson;
    if (!data || !map || !styleReady) return;
    if (outlineUrl) URL.revokeObjectURL(outlineUrl);
    outlineUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    if (!map.getSource("eg-parent")) {
      map.addSource("eg-parent", { type: "geojson", data: outlineUrl });
      map.addLayer({
        id: "eg-parent-line",
        type: "line",
        source: "eg-parent",
        paint: { "line-color": "#111", "line-width": lineWidth, "line-dasharray": [2, 1.5] },
      });
    } else {
      setSource("eg-parent", outlineUrl);
    }
  });

  $effect(() => {
    const data = resultGeojson;
    if (!data || !map || !styleReady) return;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    if (!map.getSource("eg-result")) {
      map.addSource("eg-result", { type: "geojson", data: resultUrl });
      // Insert below the parent outline (if present) so the dashed reference
      // boundary always stays visible on top of the filled result.
      const beforeId = map.getLayer("eg-parent-line") ? "eg-parent-line" : undefined;
      map.addLayer(
        {
          id: "eg-result-fill",
          type: "fill",
          source: "eg-result",
          filter: polyFilter,
          paint: { "fill-color": fillColorExpr(), "fill-opacity": 0.75 },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: "eg-result-line",
          type: "line",
          source: "eg-result",
          filter: polyFilter,
          paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": lineWidth },
        },
        beforeId,
      );
    } else {
      setSource("eg-result", resultUrl);
    }
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
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    if (outlineUrl) URL.revokeObjectURL(outlineUrl);
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
