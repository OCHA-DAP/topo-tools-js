import { loadMaplibre, loadStyle } from "$lib/utils/mapStyle";
import type { FilterSpecification, LngLatBoundsLike, Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { PMTILES_LAYER, PMTILES_URL, explorerViews } from "./explorer";

const CURRENT_FILL = "#4a90d9";
const OLDER_FILL = "#f5b8b0";
const LINE = "#2060a0";
const FILL_OPACITY = 0.6;
const PADDING = 40;

let protocolAdded = false;

const bounds = ([xmin, ymin, xmax, ymax]: number[]): LngLatBoundsLike => [
  [xmin, ymin],
  [xmax, ymax],
];

// Cycles explorerViews on one map. Every country is visited once up front and its tiles stay cached, so the flights only redraw.
export function startBoundaryLoop(
  container: HTMLElement,
  caption: HTMLElement,
  intervalMs: number,
): () => void {
  let map: MaplibreMap | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const show = (i: number, duration: number) => {
    const view = explorerViews[i];
    caption.textContent = view.caption;
    if (!map) return;
    for (const { id } of explorerViews) {
      const on = id === view.id;
      map.setPaintProperty(`${id}-fill`, "fill-opacity", on ? FILL_OPACITY : 0);
      map.setPaintProperty(`${id}-line`, "line-opacity", on ? 1 : 0);
    }
    map.fitBounds(bounds(view.bbox), { padding: PADDING, duration });
  };

  (async () => {
    const maplibregl = await loadMaplibre();
    if (!protocolAdded) {
      maplibregl.addProtocol("pmtiles", new Protocol().tile);
      protocolAdded = true;
    }
    const style = await loadStyle();
    if (stopped) return;
    style.layers = style.layers.filter(
      (l) => l.type !== "symbol" && !("source-layer" in l && l["source-layer"] === "boundary"),
    );
    const m = new maplibregl.Map({
      container,
      style,
      bounds: bounds(explorerViews[0].bbox),
      fitBoundsOptions: { padding: PADDING },
      interactive: false,
      maxTileCacheSize: 1000,
    });
    map = m;
    await m.once("load");
    m.addSource("sources", { type: "vector", url: `pmtiles://${PMTILES_URL}` });
    for (const { id, iso3, source } of explorerViews) {
      const filter: FilterSpecification = [
        "all",
        ["==", ["get", "iso3"], iso3],
        ["==", ["get", "source"], source],
      ];
      const base = {
        source: "sources",
        "source-layer": PMTILES_LAYER,
        filter,
      };
      m.addLayer({
        ...base,
        id: `${id}-fill`,
        type: "fill",
        paint: { "fill-color": source === "ocha" ? CURRENT_FILL : OLDER_FILL, "fill-opacity": 0 },
      });
      m.addLayer({
        ...base,
        id: `${id}-line`,
        type: "line",
        paint: { "line-color": LINE, "line-opacity": 0 },
      });
    }
    m.getCanvasContainer().style.visibility = "hidden";
    for (const bbox of new Set(explorerViews.map((v) => v.bbox)).values()) {
      m.fitBounds(bounds(bbox), { padding: PADDING, duration: 0 });
      await m.once("idle");
      if (stopped) return;
    }
    let i = 0;
    show(i, 0);
    m.getCanvasContainer().style.visibility = "";
    timer = setInterval(() => show((i = (i + 1) % explorerViews.length), 800), intervalMs);
  })();

  caption.textContent = explorerViews[0].caption;
  return () => {
    stopped = true;
    clearInterval(timer);
    map?.remove();
    map = undefined;
  };
}
