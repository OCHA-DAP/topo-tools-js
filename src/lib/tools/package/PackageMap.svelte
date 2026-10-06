<script lang="ts">
  import { loadMaplibre, loadStyle } from "$lib/utils/mapStyle";
  import { createSpin } from "$lib/utils/spin";
  import MapPopup, { type FeatureInfo } from "$lib/components/MapPopup.svelte";
  import type {
    ExpressionSpecification,
    GeoJSONSource,
    LngLatLike,
    Map as MaplibreMap,
    MapGeoJSONFeature,
  } from "maplibre-gl";
  import type { FeatureCollection } from "geojson";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { byDepth, type LevelStyle } from "./levelStyle";
  import { GROUP_COLOR, GROUP_FILL_OPACITY } from "$lib/utils/groupColor";

  let {
    polygons = null,
    polygonLevel = null,
    lines = null,
    points = null,
    styles,
    depthColumn,
    labelField = null,
    mode,
    bounds = null,
    processing = false,
  }: {
    polygons?: FeatureCollection | null;
    polygonLevel?: number | null;
    lines?: string | null;
    points?: string | null;
    styles: LevelStyle[];
    depthColumn: string;
    labelField?: string | null;
    mode: "polygons" | "features";
    bounds?: [number, number, number, number] | null;
    processing?: boolean;
  } = $props();

  const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
  const LAYERS = {
    polygons: ["pk-poly-fill", "pk-poly-line"],
    features: ["pk-lines", "pk-lines-hit", "pk-labels"],
  } as const;

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let ready = $state(false);
  let hasLabels = false;
  let hovered = $state<FeatureInfo[]>([]);
  let hoverLngLat = $state<LngLatLike | null>(null);
  const urls = new Map<string, string>();
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  $effect(() => {
    if (processing) stopSpin();
  });

  function setSource(id: string, data: string | FeatureCollection | null): void {
    const src = map?.getSource(id) as GeoJSONSource | undefined;
    if (!src) return;
    if (typeof data !== "string") {
      src.setData(data ?? EMPTY);
      return;
    }
    const prev = urls.get(id);
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    urls.set(id, url);
    src.setData(url);
  }

  $effect(() => {
    const data = polygons;
    if (ready) setSource("pk-polygons", data);
  });
  $effect(() => {
    const data = lines;
    if (ready) setSource("pk-lines", data);
  });
  $effect(() => {
    const data = points;
    if (ready) setSource("pk-points", data);
  });

  function zoomed(pick: (s: LevelStyle) => number, low: number, high: number): ExpressionSpecification {
    return [
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["*", low, byDepth(styles, depthColumn, pick)],
      10,
      ["*", high, byDepth(styles, depthColumn, pick)],
    ] as unknown as ExpressionSpecification;
  }

  // Level-dependent paint, reapplied whenever a run changes the set of levels.
  $effect(() => {
    if (!ready || !map || styles.length === 0) return;
    const color = byDepth(styles, depthColumn, (s) => s.color);
    map.setPaintProperty("pk-lines", "line-color", color);
    map.setPaintProperty("pk-lines", "line-width", zoomed((s) => s.width, 0.6, 1.3));
    map.setPaintProperty(
      "pk-lines",
      "line-dasharray",
      byDepth(styles, depthColumn, (s) => ["literal", s.dash ?? [1, 0]]),
    );
    if (hasLabels) {
      map.setPaintProperty("pk-labels", "text-color", color);
      map.setLayoutProperty("pk-labels", "text-size", byDepth(styles, depthColumn, (s) => s.textSize));
      map.setLayoutProperty(
        "pk-labels",
        "text-font",
        byDepth(styles, depthColumn, (s) => ["literal", [s.bold ? "Noto Sans Bold" : "Noto Sans Regular"]]),
      );
    }
  });

  $effect(() => {
    const field = labelField;
    if (ready && hasLabels) map!.setLayoutProperty("pk-labels", "text-field", field ? ["get", field] : "");
  });

  $effect(() => {
    const active = mode;
    if (!ready || !map) return;
    for (const [kind, ids] of Object.entries(LAYERS)) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", kind === active ? "visible" : "none");
      }
    }
    hovered = [];
  });

  $effect(() => {
    const b = bounds;
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

  function levelTone(depth: unknown): string | undefined {
    return styles.find((s) => s.depth === Number(depth))?.color;
  }

  function fieldsOf(props: Record<string, unknown>, skip: string[]): FeatureInfo["fields"] {
    return Object.entries(props)
      .filter(([k, v]) => !skip.includes(k) && v != null && v !== "")
      .map(([k, v]) => [k, String(v)]);
  }

  function describe(f: MapGeoJSONFeature): FeatureInfo {
    const p = f.properties ?? {};
    const depth = p[depthColumn];
    if (f.layer.id === "pk-poly-fill") {
      const names = Object.keys(p).filter((k) => /(^|_)name$/i.test(k));
      const name = names.find((k) => k.replace(/\D/g, "") === String(polygonLevel)) ?? names.at(-1);
      return {
        title: name ? String(p[name]) : `Level ${polygonLevel} unit`,
        tag: `level ${polygonLevel}`,
        tone: String(p[GROUP_COLOR]),
        fields: fieldsOf(p, ["fid", GROUP_COLOR]),
      };
    }
    if (f.layer.id === "pk-labels") {
      return {
        title: labelField && p[labelField] ? String(p[labelField]) : "Label point",
        tag: `level ${depth}`,
        tone: levelTone(depth),
        fields: fieldsOf(p, ["fid", depthColumn]),
      };
    }
    const exterior = Object.entries(p).every(([k, v]) => !k.startsWith("b_") || v == null);
    return {
      title: exterior ? "Exterior boundary" : "Shared boundary",
      tag: exterior ? "outline" : `level ${depth}`,
      tone: levelTone(depth),
      fields: fieldsOf(p, ["fid", depthColumn]),
    };
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
      maxZoom: 25,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    map.once("load", () => {
      const m = map!;
      // Unit labels replace the basemap's own place names.
      for (const l of m.getStyle().layers) if (l.type === "symbol") m.setLayoutProperty(l.id, "visibility", "none");
      for (const id of ["pk-polygons", "pk-lines", "pk-points"]) m.addSource(id, { type: "geojson", data: EMPTY });
      m.addLayer({
        id: "pk-poly-fill",
        type: "fill",
        source: "pk-polygons",
        paint: { "fill-color": ["get", GROUP_COLOR], "fill-opacity": GROUP_FILL_OPACITY },
      });
      m.addLayer({
        id: "pk-poly-line",
        type: "line",
        source: "pk-polygons",
        paint: { "line-color": "#3f4748", "line-width": 0.6, "line-opacity": 0.7 },
      });
      m.addLayer({
        id: "pk-lines",
        type: "line",
        source: "pk-lines",
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["-", ["get", depthColumn]] },
      });
      m.addLayer({
        id: "pk-lines-hit",
        type: "line",
        source: "pk-lines",
        paint: { "line-width": 8, "line-opacity": 0 },
      });
      hasLabels = Boolean(m.getStyle().glyphs);
      if (hasLabels) {
        m.addLayer({
          id: "pk-labels",
          type: "symbol",
          source: "pk-points",
          layout: {
            "symbol-sort-key": ["get", depthColumn],
            "text-max-width": 8,
          },
          paint: { "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });
      }
      const hitLayers = ["pk-labels", "pk-lines-hit", "pk-poly-fill"].filter((id) => m.getLayer(id));
      m.on("mousemove", (e) => {
        const visible = hitLayers.filter((id) => m.getLayoutProperty(id, "visibility") !== "none");
        const f = m.queryRenderedFeatures(e.point, { layers: visible })[0];
        hovered = f ? [describe(f)] : [];
        hoverLngLat = e.lngLat;
        m.getCanvas().style.cursor = f ? "pointer" : "";
      });
      m.on("mouseout", () => (hovered = []));
      ready = true;
      startSpin();
      m.on("mousedown", stopSpin);
      m.on("touchstart", stopSpin);
      m.on("wheel", stopSpin);
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    for (const url of urls.values()) URL.revokeObjectURL(url);
  });
</script>

<div bind:this={container} class="pk-map"></div>
<MapPopup getMap={() => map} items={hovered} lngLat={hoverLngLat} />

<style>
  .pk-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
</style>
