<script lang="ts">
  import type {
    GeoJSONSource,
    Map as MaplibreMap,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { loadMaplibre, loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";

  let {
    geojson = null,
    originalGeojson = null,
    originalOutline = false,
    bounds = null,
    processing = false,
    registerClear = undefined,
    onFeatureClick = undefined,
  }: {
    geojson?: string | null;
    originalGeojson?: string | null;
    // Draws originalGeojson as outlines above the result instead of a fill.
    originalOutline?: boolean;
    bounds?: [number, number, number, number] | null;
    processing?: boolean;
    registerClear?: (fn: () => void) => void;
    onFeatureClick?: (lngLat: [number, number] | null) => void;
  } = $props();

  let container: HTMLDivElement | undefined;
  let map = $state.raw<MaplibreMap | undefined>();
  let styleReady = $state(false);
  let blobUrl: string | undefined;
  let origBlobUrl: string | undefined;
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);
  let selected: { source: string; id: string | number } | undefined;

  function clearSelection() {
    if (selected && map?.getSource(selected.source)) map.removeFeatureState(selected);
    selected = undefined;
  }

  function addSelectedLayer(source: string) {
    if (!map || !onFeatureClick) return;
    map.addLayer({
      id: `${source}-selected`,
      type: "line",
      source,
      paint: {
        "line-color": "#dc2626",
        "line-width": 3,
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0],
      },
    });
  }

  $effect(() => {
    if (processing) stopSpin();
  });

  // Effects gate on styleReady, not isStyleLoaded(): adding a GeoJSON source flips
  // isStyleLoaded() false, and the one-shot "load" event has already fired.
  $effect(() => {
    const b = bounds;
    if (!b || !map || !styleReady) return;
    const [minLng, minLat, maxLng, maxLat] = b;
    stopSpin();
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 40, animate: true });
  });

  $effect(() => {
    const orig = originalGeojson;
    if (!orig || !map || !styleReady) return;

    if (origBlobUrl) URL.revokeObjectURL(origBlobUrl);
    origBlobUrl = URL.createObjectURL(new Blob([orig], { type: "application/json" }));
    const oUrl = origBlobUrl;

    function apply() {
      if (!map) return;
      if (map.getSource("original")) {
        if (selected?.source === "original") clearSelection();
        (map.getSource("original") as GeoJSONSource).setData(oUrl);
      } else {
        map.addSource("original", { type: "geojson", data: oUrl, generateId: true });
        if (originalOutline) {
          map.addLayer({ id: "original-line", type: "line", source: "original", paint: { "line-color": "#111827", "line-width": 2 } });
        } else {
          map.addLayer({ id: "original-fill", type: "fill", source: "original", filter: polyFilter, paint: { "fill-color": "#8dc65a", "fill-opacity": 1 } });
          map.addLayer({ id: "original-line", type: "line", source: "original", paint: { "line-color": "#222222", "line-width": lineWidth } });
          addSelectedLayer("original");
        }
      }
    }

    apply();
  });

  $effect(() => {
    const result = geojson;
    if (!result || !map || !styleReady) return;

    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([result], { type: "application/json" }));
    const rUrl = blobUrl;

    function apply() {
      if (!map) return;
      // Insert result layers below original if original is already shown
      const before = ["original-fill", "original-line"].find((l) => map?.getLayer(l));
      if (map.getSource("result")) {
        if (selected?.source === "result") clearSelection();
        (map.getSource("result") as GeoJSONSource).setData(rUrl);
      } else {
        map.addSource("result", { type: "geojson", data: rUrl, generateId: true });
        map.addLayer({ id: "result-fill", type: "fill", source: "result", filter: polyFilter, paint: { "fill-color": "#aad4e0", "fill-opacity": 1 } }, before);
        map.addLayer({ id: "result-line", type: "line", source: "result", paint: { "line-color": "#222222", "line-width": lineWidth } }, before);
        addSelectedLayer("result");
      }
    }

    apply();
  });

  onMount(async () => {
    if (!container) return;
    const maplibregl = await loadMaplibre();
    const style = await loadStyle();
    const size = Math.min(container.clientWidth, container.clientHeight);
    map = new maplibregl.Map({
      container,
      style,
      center: [20, 5],
      zoom: Math.log2((size * Math.PI) / 512),
      attributionControl: { compact: true },
    });
    map.once("load", () => {
      styleReady = true;
      startSpin();
      map.on("mousedown", stopSpin);
      map.on("touchstart", stopSpin);
      map.on("wheel", stopSpin);
      if (onFeatureClick) {
        const fills = () => ["original-fill", "result-fill"].filter((l) => map?.getLayer(l));
        map.on("mousemove", (e) => {
          if (!map) return;
          const hit = map.queryRenderedFeatures(e.point, { layers: fills() }).length > 0;
          map.getCanvas().style.cursor = hit ? "pointer" : "";
        });
        map.on("click", (e) => {
          if (!map) return;
          const f = map.queryRenderedFeatures(e.point, { layers: fills() })[0];
          clearSelection();
          if (f?.id === undefined) {
            onFeatureClick?.(null);
            return;
          }
          selected = { source: f.source, id: f.id };
          map.setFeatureState(selected, { selected: true });
          onFeatureClick?.([e.lngLat.lng, e.lngLat.lat]);
        });
      }
      registerClear?.(() => {
        if (!map) return;
        selected = undefined;
        const layers = ["original-fill", "original-line", "original-selected", "result-fill", "result-line", "result-selected"];
        const sources = ["original", "result"];
        for (const layer of layers) {
          if (map.getLayer(layer)) map.removeLayer(layer);
        }
        for (const source of sources) {
          if (map.getSource(source)) map.removeSource(source);
        }
      });
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (origBlobUrl) URL.revokeObjectURL(origBlobUrl);
  });
</script>

<div bind:this={container} class="map"></div>

<style>
  .map {
    width: 100%;
    height: 100%;
  }
</style>
