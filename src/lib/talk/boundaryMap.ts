import { loadMaplibre, loadStyle } from "$lib/utils/mapStyle";
import type { FilterSpecification, LngLatBoundsLike, Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { FileSource, PMTiles, Protocol } from "pmtiles";
import { PMTILES_LAYER, PMTILES_URL, explorerViews } from "./explorer";

const CURRENT_FILL = "#4a90d9";
const OLDER_FILL = "#f5b8b0";
const LINE = "#2060a0";
const FILL_OPACITY = 0.6;
const PADDING = 40;

let protocolAdded = false;
let archive: Promise<File> | undefined;

const bounds = ([xmin, ymin, xmax, ymax]: number[]): LngLatBoundsLike => [
  [xmin, ymin],
  [xmax, ymax],
];

// One whole-file request, so tiles read from memory and a stalled range request can't blank the map.
export const loadBoundaries = () =>
  (archive ??= fetch(PMTILES_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${PMTILES_URL}`);
      return new File([await res.blob()], PMTILES_URL);
    })
    .catch((e) => {
      archive = undefined;
      throw e;
    }));

// Cycles explorerViews on one map.
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
    const [maplibregl, style, file] = await Promise.all([
      loadMaplibre(),
      loadStyle(),
      loadBoundaries(),
    ]);
    if (!protocolAdded) {
      const protocol = new Protocol();
      protocol.add(new PMTiles(new FileSource(file)));
      maplibregl.addProtocol("pmtiles", protocol.tile);
      protocolAdded = true;
    }
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
        paint: {
          "fill-color": ["case", ["get", "matches_ocha"], CURRENT_FILL, OLDER_FILL],
          "fill-opacity": 0,
        },
      });
      m.addLayer({
        ...base,
        id: `${id}-line`,
        type: "line",
        paint: { "line-color": LINE, "line-opacity": 0 },
      });
    }
    let i = 0;
    show(i, 0);
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
