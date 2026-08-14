<script lang="ts">
  import { lineWidth, loadMaplibre, loadStyle, polyFilter } from "$lib/utils/mapStyle";
  import { createSpin } from "$lib/utils/spin";
  import type {
    ExpressionSpecification,
    FilterSpecification,
    GeoJSONSource,
    Map as MaplibreMap,
    MapMouseEvent,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";

  let {
    originalGeojson = null,
    issuesGeojson = null,
    bounds = null,
    focusBbox = null,
    selectedKey = null,
    processing = false,
    onIssueClick,
  }: {
    originalGeojson?: string | null;
    issuesGeojson?: string | null;
    bounds?: [number, number, number, number] | null;
    focusBbox?: [number, number, number, number] | null;
    selectedKey?: string | null;
    processing?: boolean;
    onIssueClick?: (key: string | null) => void;
  } = $props();

  const ORIGINAL_FILL = "#8dc65a"; // green
  const OVERLAP = "#e11d48"; // red
  const GAP = "#f59e0b"; // amber

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let styleReady = $state(false);
  const urls = new Map<string, string>();
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  $effect(() => {
    if (processing) stopSpin();
  });

  const issueColor: ExpressionSpecification = [
    "match",
    ["get", "kind"],
    "overlap",
    OVERLAP,
    "gap",
    GAP,
    "#888888",
  ] as unknown as ExpressionSpecification;

  function setData(id: string, data: string): string {
    const prev = urls.get(id);
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    urls.set(id, url);
    return url;
  }

  function upsertSource(id: string, data: string | null): boolean {
    if (!map || !styleReady || !data) return false;
    const url = setData(id, data);
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) {
      src.setData(url);
      return false;
    }
    map.addSource(id, { type: "geojson", data: url });
    return true;
  }

  $effect(() => {
    if (upsertSource("dt-original", originalGeojson)) {
      map!.addLayer({
        id: "dt-original-fill",
        type: "fill",
        source: "dt-original",
        filter: polyFilter,
        paint: { "fill-color": ORIGINAL_FILL, "fill-opacity": 1 },
      });
      map!.addLayer({
        id: "dt-original-line",
        type: "line",
        source: "dt-original",
        paint: { "line-color": "#222222", "line-width": lineWidth as unknown as number },
      });
    }
  });

  $effect(() => {
    if (upsertSource("dt-issues", issuesGeojson)) {
      map!.addLayer({
        id: "dt-issues-fill",
        type: "fill",
        source: "dt-issues",
        filter: polyFilter,
        paint: { "fill-color": issueColor, "fill-opacity": 0.55 },
      });
      map!.addLayer({
        id: "dt-issues-outline",
        type: "line",
        source: "dt-issues",
        filter: polyFilter,
        paint: { "line-color": issueColor, "line-width": 1.5, "line-opacity": 0.6 },
      });
      map!.addLayer({
        id: "dt-issues-highlight",
        type: "line",
        source: "dt-issues",
        filter: ["==", ["get", "key"], ""] as FilterSpecification,
        paint: { "line-color": "#111111", "line-width": 3, "line-opacity": 0.6 },
      });
      map!.on("click", "dt-issues-fill", (e) => {
        const key = e.features?.[0]?.properties?.key;
        onIssueClick?.(key == null ? null : String(key));
      });
      map!.on("mouseenter", "dt-issues-fill", () => {
        if (map) map.getCanvas().style.cursor = "pointer";
      });
      map!.on("mouseleave", "dt-issues-fill", () => {
        if (map) map.getCanvas().style.cursor = "";
      });
    }
  });

  // Highlight the selected issue.
  $effect(() => {
    const key = selectedKey;
    if (!map || !styleReady) return;
    if (map.getLayer("dt-issues-highlight")) {
      map.setFilter("dt-issues-highlight", [
        "==",
        ["get", "key"],
        key ?? "",
      ] as FilterSpecification);
    }
  });

  // Initial fit to the whole coverage. fitBounds is called directly (not gated on
  // isStyleLoaded) because adding GeoJSON sources flips isStyleLoaded() false and
  // the one-shot "load" event has already fired.
  $effect(() => {
    const b = bounds;
    const ready = styleReady;
    if (!b || !map || !ready) return;
    stopSpin();
    map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: 40, animate: true },
    );
  });

  // Zoom to a clicked issue. App passes a fresh array per click so re-selecting
  // the same issue re-triggers the zoom.
  $effect(() => {
    const b = focusBbox;
    const ready = styleReady;
    if (!b || !map || !ready) return;
    stopSpin();
    map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      // Larger issues cap out sooner on their own bbox; smaller ones benefit from
      // zooming in further to be legible.
      { padding: 120, maxZoom: 25, animate: true },
    );
  });

  function handleMapClick(e: MapMouseEvent): void {
    if (!map || !onIssueClick) return;
    if (!map.getLayer("dt-issues-fill")) return;
    // Clicking empty space (not an issue) clears the selection.
    const feats = map.queryRenderedFeatures(e.point, { layers: ["dt-issues-fill"] });
    if (feats.length === 0) onIssueClick(null);
  }

  onMount(async () => {
    if (!container) return;
    const maplibregl = await loadMaplibre();
    const style = await loadStyle();
    map = new maplibregl.Map({
      container,
      style,
      center: [20, 5],
      zoom: Math.log2((Math.min(container.clientWidth, container.clientHeight) * Math.PI) / 512),
      // Default maxZoom is 22; raise to MapLibre's hard max so small issues can
      // be inspected closely. Basemap tiles overzoom (blur) past ~z14 but the
      // vector issue overlay stays crisp at any zoom.
      maxZoom: 25,
      attributionControl: { compact: true },
    });
    // Distance scale bar so the zoomed-in scale is legible.
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    map.once("load", () => {
      styleReady = true;
      startSpin();
      map?.on("mousedown", stopSpin);
      map?.on("touchstart", stopSpin);
      map?.on("wheel", stopSpin);
      map?.on("click", handleMapClick);
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    for (const url of urls.values()) URL.revokeObjectURL(url);
  });
</script>

<div bind:this={container} class="dt-map"></div>

<style>
  .dt-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
</style>
