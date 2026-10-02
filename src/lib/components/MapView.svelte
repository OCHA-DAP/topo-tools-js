<script lang="ts">
  import type {
    GeoJSONSource,
    Map as MaplibreMap,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { MAP_COLORS, MAP_FILL_OPACITY } from "$lib/utils/mapColors";
  import { loadMaplibre, loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";

  let {
    geojson = null,
    originalGeojson = null,
    overlayOutlineGeojson = null,
    showSide = undefined,
    bounds = null,
    processing = false,
    registerClear = undefined,
    onFeatureClick = undefined,
  }: {
    geojson?: string | null;
    originalGeojson?: string | null;
    // Drawn as outlines above both fills, not selectable.
    overlayOutlineGeojson?: string | null;
    // Shows only the original ("a") or only the result ("b") instead of stacking them.
    showSide?: "a" | "b";
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
  let overlayBlobUrl: string | undefined;
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);
  let selected: { source: string; id: string | number } | undefined;

  function clearSelection() {
    if (selected && map?.getSource(selected.source)) map.removeFeatureState(selected);
    selected = undefined;
  }

  function addSelectedLayer(source: string, before?: string) {
    if (!map || !onFeatureClick) return;
    map.addLayer(
      {
        id: `${source}-selected`,
        type: "line",
        source,
        paint: {
          "line-color": MAP_COLORS.selected,
          "line-width": 3,
          "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0],
        },
      },
      before,
    );
  }

  function removeSide(source: "original" | "result" | "overlay") {
    if (!map) return;
    if (selected?.source === source) selected = undefined;
    for (const suffix of ["fill", "line", "selected"]) {
      if (map.getLayer(`${source}-${suffix}`)) map.removeLayer(`${source}-${suffix}`);
    }
    if (map.getSource(source)) map.removeSource(source);
  }

  $effect(() => {
    if (processing) stopSpin();
  });

  function applySide() {
    if (!map) return;
    const sides = { original: showSide !== "b", result: showSide !== "a" };
    for (const [source, visible] of Object.entries(sides)) {
      for (const suffix of ["fill", "line", "selected"]) {
        const id = `${source}-${suffix}`;
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  }

  $effect(() => {
    const _side = showSide;
    if (map && styleReady) applySide();
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
    if (!map || !styleReady) return;
    if (!orig) return removeSide("original");

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
        const before = map.getLayer("overlay-line") ? "overlay-line" : undefined;
        map.addLayer({ id: "original-fill", type: "fill", source: "original", filter: polyFilter, paint: { "fill-color": MAP_COLORS.original, "fill-opacity": MAP_FILL_OPACITY } }, before);
        map.addLayer({ id: "original-line", type: "line", source: "original", paint: { "line-color": MAP_COLORS.outline, "line-width": lineWidth } }, before);
        addSelectedLayer("original", before);
        applySide();
      }
    }

    apply();
  });

  $effect(() => {
    const result = geojson;
    if (!map || !styleReady) return;
    if (!result) return removeSide("result");

    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([result], { type: "application/json" }));
    const rUrl = blobUrl;

    function apply() {
      if (!map) return;
      // Insert result layers below original if original is already shown
      const before = ["original-fill", "overlay-line"].find((l) => map?.getLayer(l));
      if (map.getSource("result")) {
        if (selected?.source === "result") clearSelection();
        (map.getSource("result") as GeoJSONSource).setData(rUrl);
      } else {
        map.addSource("result", { type: "geojson", data: rUrl, generateId: true });
        map.addLayer({ id: "result-fill", type: "fill", source: "result", filter: polyFilter, paint: { "fill-color": MAP_COLORS.result, "fill-opacity": MAP_FILL_OPACITY } }, before);
        map.addLayer({ id: "result-line", type: "line", source: "result", paint: { "line-color": MAP_COLORS.outline, "line-width": lineWidth } }, before);
        addSelectedLayer("result", before);
        applySide();
      }
    }

    apply();
  });

  $effect(() => {
    const overlay = overlayOutlineGeojson;
    if (!map || !styleReady) return;
    if (!overlay) return removeSide("overlay");

    if (overlayBlobUrl) URL.revokeObjectURL(overlayBlobUrl);
    overlayBlobUrl = URL.createObjectURL(new Blob([overlay], { type: "application/json" }));
    if (map.getSource("overlay")) {
      (map.getSource("overlay") as GeoJSONSource).setData(overlayBlobUrl);
    } else {
      map.addSource("overlay", { type: "geojson", data: overlayBlobUrl });
      map.addLayer({ id: "overlay-line", type: "line", source: "overlay", paint: { "line-color": MAP_COLORS.outline, "line-width": 2 } });
    }
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
        removeSide("original");
        removeSide("result");
        removeSide("overlay");
      });
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (origBlobUrl) URL.revokeObjectURL(origBlobUrl);
    if (overlayBlobUrl) URL.revokeObjectURL(overlayBlobUrl);
  });
</script>

<div bind:this={container} class="map"></div>

<style>
  .map {
    width: 100%;
    height: 100%;
  }
</style>
