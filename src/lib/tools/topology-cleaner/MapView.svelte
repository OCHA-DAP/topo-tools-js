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
    cleanedGeojson = null,
    issuesGeojson = null,
    sliverVerticesGeojson = null,
    selectMode = false,
    selectionBbox = null,
    bounds = null,
    focusBbox = null,
    selectedKey = null,
    showSide = "b" as "a" | "b",
    processing = false,
    onIssueClick,
    onBoxSelect,
  }: {
    originalGeojson?: string | null;
    cleanedGeojson?: string | null;
    issuesGeojson?: string | null;
    sliverVerticesGeojson?: string | null;
    selectMode?: boolean;
    selectionBbox?: [number, number, number, number] | null;
    bounds?: [number, number, number, number] | null;
    focusBbox?: [number, number, number, number] | null;
    selectedKey?: string | null;
    showSide?: "a" | "b";
    processing?: boolean;
    onIssueClick?: (key: string | null) => void;
    onBoxSelect?: (bbox: [number, number, number, number]) => void;
  } = $props();

  const EMPTY_FC = '{"type":"FeatureCollection","features":[]}';
  const VERTEX = "#2563eb"; // selectable sliver-vertex dots (blue)
  const VERTEX_SELECTED = "#dc2626"; // dots inside the current selection box (red)

  const ORIGINAL_FILL = "#8dc65a"; // green
  const CLEANED_FILL = "#aad4e0"; // blue
  const OVERLAP = "#e11d48"; // red
  const GAP = "#f59e0b"; // amber
  const SLIVER = "#7c3aed"; // purple

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let styleReady = $state(false);
  let sidePending: number | undefined;
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
    "sliver",
    SLIVER,
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
    if (upsertSource("tc-original", originalGeojson)) {
      map!.addLayer({
        id: "tc-original-fill",
        type: "fill",
        source: "tc-original",
        filter: polyFilter,
        layout: { visibility: "none" },
        paint: { "fill-color": ORIGINAL_FILL, "fill-opacity": 1 },
      });
      map!.addLayer({
        id: "tc-original-line",
        type: "line",
        source: "tc-original",
        layout: { visibility: "none" },
        paint: { "line-color": "#222222", "line-width": lineWidth as unknown as number },
      });
      applySideVisibility(showSide);
    }
  });

  $effect(() => {
    if (upsertSource("tc-cleaned", cleanedGeojson)) {
      map!.addLayer({
        id: "tc-cleaned-fill",
        type: "fill",
        source: "tc-cleaned",
        filter: polyFilter,
        layout: { visibility: "none" },
        paint: { "fill-color": CLEANED_FILL, "fill-opacity": 1 },
      });
      map!.addLayer({
        id: "tc-cleaned-line",
        type: "line",
        source: "tc-cleaned",
        layout: { visibility: "none" },
        paint: { "line-color": "#222222", "line-width": lineWidth as unknown as number },
      });
      applySideVisibility(showSide);
    }
  });

  $effect(() => {
    if (upsertSource("tc-issues", issuesGeojson)) {
      map!.addLayer({
        id: "tc-issues-fill",
        type: "fill",
        source: "tc-issues",
        filter: polyFilter,
        layout: { visibility: "none" },
        paint: { "fill-color": issueColor, "fill-opacity": 0.55 },
      });
      map!.addLayer({
        id: "tc-issues-outline",
        type: "line",
        source: "tc-issues",
        filter: polyFilter,
        layout: { visibility: "none" },
        paint: { "line-color": issueColor, "line-width": 1.5, "line-opacity": 0.6 },
      });
      // Slivers are line geometries (the offending edges); render them as lines.
      map!.addLayer({
        id: "tc-issues-sliver",
        type: "line",
        source: "tc-issues",
        filter: ["==", ["get", "kind"], "sliver"] as FilterSpecification,
        layout: { visibility: "none", "line-cap": "round" },
        paint: { "line-color": SLIVER, "line-width": 3, "line-opacity": 0.6 },
      });
      map!.addLayer({
        id: "tc-issues-highlight",
        type: "line",
        source: "tc-issues",
        filter: ["==", ["get", "key"], ""] as FilterSpecification,
        layout: { visibility: "none" },
        paint: { "line-color": "#111111", "line-width": 3, "line-opacity": 0.6 },
      });
      for (const layer of ["tc-issues-fill", "tc-issues-sliver"]) {
        map!.on("click", layer, (e) => {
          const key = e.features?.[0]?.properties?.key;
          onIssueClick?.(key == null ? null : String(key));
        });
        map!.on("mouseenter", layer, () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map!.on("mouseleave", layer, () => {
          if (map) map.getCanvas().style.cursor = "";
        });
      }
      applySideVisibility(showSide);
    }
  });

  // Selectable sliver-adjacent vertices, shown as dots while in select mode.
  $effect(() => {
    const data = sliverVerticesGeojson ?? EMPTY_FC;
    if (upsertSource("tc-vertices", data)) {
      map!.addLayer({
        id: "tc-vertices",
        type: "circle",
        source: "tc-vertices",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 4,
          "circle-color": VERTEX,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
        },
      });
      applySideVisibility(showSide);
    }
  });

  // Persistent outline of the current selection box (after a drag, before Snap).
  $effect(() => {
    const b = selectionBbox;
    const fc = b
      ? JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [b[0], b[1]],
                    [b[2], b[1]],
                    [b[2], b[3]],
                    [b[0], b[3]],
                    [b[0], b[1]],
                  ],
                ],
              },
            },
          ],
        })
      : EMPTY_FC;
    if (upsertSource("tc-selbox", fc)) {
      map!.addLayer({
        id: "tc-selbox",
        type: "line",
        source: "tc-selbox",
        layout: { visibility: "none" },
        paint: { "line-color": VERTEX_SELECTED, "line-width": 1.5, "line-dasharray": [2, 1] },
      });
      applySideVisibility(showSide);
    }
  });

  // Highlight the selected issue.
  $effect(() => {
    const key = selectedKey;
    if (!map || !styleReady) return;
    if (map.getLayer("tc-issues-highlight")) {
      map.setFilter("tc-issues-highlight", [
        "==",
        ["get", "key"],
        key ?? "",
      ] as FilterSpecification);
    }
  });

  function applySideVisibility(side: "a" | "b"): void {
    if (!map) return;
    const vis = (id: string, v: boolean) => {
      if (map!.getLayer(id)) map!.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    };
    const isA = side === "a";
    // Version A: original coverage + issue overlays. Version B: cleaned result.
    vis("tc-original-fill", isA);
    vis("tc-original-line", isA);
    vis("tc-issues-fill", isA);
    vis("tc-issues-outline", isA);
    vis("tc-issues-sliver", isA);
    vis("tc-issues-highlight", isA);
    vis("tc-vertices", isA && selectMode);
    vis("tc-selbox", isA && selectMode);
    vis("tc-cleaned-fill", !isA);
    vis("tc-cleaned-line", !isA);
  }

  $effect(() => {
    const side = showSide;
    void selectMode; // re-apply visibility when select mode toggles
    if (!map || !styleReady) return;
    if (sidePending !== undefined) cancelAnimationFrame(sidePending);
    sidePending = requestAnimationFrame(() => applySideVisibility(side));
  });

  // Rubber-band box select (select mode): drag a rectangle; on release, report its
  // geographic bbox. Drag-pan is suspended while a box is being drawn.
  let boxEl: HTMLDivElement | undefined;
  let dragStart: { x: number; y: number } | undefined;

  function onDown(e: MapMouseEvent): void {
    if (!selectMode || !map || !container) return;
    const oe = e.originalEvent as MouseEvent;
    if (oe.button !== 0) return;
    map.dragPan.disable();
    dragStart = { x: oe.clientX, y: oe.clientY };
    boxEl = document.createElement("div");
    boxEl.className = "tc-selbox-live";
    container.appendChild(boxEl);
  }

  function onMove(e: MapMouseEvent): void {
    if (!dragStart || !boxEl) return;
    const oe = e.originalEvent as MouseEvent;
    const rect = container!.getBoundingClientRect();
    const x = Math.min(dragStart.x, oe.clientX) - rect.left;
    const y = Math.min(dragStart.y, oe.clientY) - rect.top;
    boxEl.style.left = `${x}px`;
    boxEl.style.top = `${y}px`;
    boxEl.style.width = `${Math.abs(oe.clientX - dragStart.x)}px`;
    boxEl.style.height = `${Math.abs(oe.clientY - dragStart.y)}px`;
  }

  function onUp(e: MapMouseEvent): void {
    if (!dragStart || !map) return;
    const oe = e.originalEvent as MouseEvent;
    const start = dragStart;
    dragStart = undefined;
    if (boxEl) {
      boxEl.remove();
      boxEl = undefined;
    }
    map.dragPan.enable();
    const rect = container!.getBoundingClientRect();
    const p0 = { x: start.x - rect.left, y: start.y - rect.top };
    const p1 = { x: oe.clientX - rect.left, y: oe.clientY - rect.top };
    if (Math.abs(p1.x - p0.x) < 3 && Math.abs(p1.y - p0.y) < 3) return; // a click, not a drag
    const a = map.unproject([p0.x, p0.y]);
    const b = map.unproject([p1.x, p1.y]);
    onBoxSelect?.([
      Math.min(a.lng, b.lng),
      Math.min(a.lat, b.lat),
      Math.max(a.lng, b.lng),
      Math.max(a.lat, b.lat),
    ]);
  }

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
      // Zoom in as far as z25 for tiny slivers; larger issues cap out sooner on their own bbox.
      { padding: 120, maxZoom: 25, animate: true },
    );
  });

  function handleMapClick(e: MapMouseEvent): void {
    if (!map || !onIssueClick) return;
    const layers = ["tc-issues-fill", "tc-issues-sliver"].filter((l) => map!.getLayer(l));
    if (layers.length === 0) return;
    // Clicking empty space (not an issue) clears the selection.
    const feats = map.queryRenderedFeatures(e.point, { layers });
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
      // Default maxZoom is 22; raise to MapLibre's hard max so the sub-metre
      // sliver slits can be inspected manually. Basemap tiles overzoom (blur)
      // past ~z14 but the vector issue overlay stays crisp at any zoom.
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
      map?.on("mousedown", onDown);
      map?.on("mousemove", onMove);
      map?.on("mouseup", onUp);
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    for (const url of urls.values()) URL.revokeObjectURL(url);
  });
</script>

<div bind:this={container} class="tc-map" class:tc-selecting={selectMode}></div>

<style>
  .tc-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
  .tc-map.tc-selecting :global(.maplibregl-canvas) {
    cursor: crosshair;
  }
  .tc-map :global(.tc-selbox-live) {
    position: absolute;
    border: 1.5px dashed #dc2626;
    background: rgba(220, 38, 38, 0.1);
    pointer-events: none;
    z-index: 5;
  }
</style>
