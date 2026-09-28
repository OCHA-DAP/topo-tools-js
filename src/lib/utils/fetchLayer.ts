import { CSV_EXTS, SHP_EXTS, SINGLE_EXTS, extOf } from "./formats";

export class FetchLayerError extends Error {}

const CONTENT_TYPE_EXTS: [RegExp, string][] = [
  [/geo\+json/, ".geojson"],
  [/zip/, ".zip"],
  [/parquet/, ".parquet"],
  [/geopackage/, ".gpkg"],
  [/flatgeobuf/, ".fgb"],
  [/kml/, ".kml"],
  [/gpx/, ".gpx"],
  [/csv/, ".csv"],
];

export function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function basename(pathname: string): string {
  try {
    return decodeURIComponent(pathname.split("/").pop() ?? "");
  } catch {
    return pathname.split("/").pop() ?? "";
  }
}

function dispositionName(header: string | null): string {
  if (!header) return "";
  const star = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain filename parameter
    }
  }
  return header.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1].trim() ?? "";
}

function sniffExt(head: Uint8Array): string {
  const ascii = new TextDecoder("latin1").decode(head).trimStart();
  if (ascii.startsWith("PAR1")) return ".parquet";
  if (ascii.startsWith("PK\x03\x04")) return ".zip";
  if (ascii.startsWith("SQLite format 3")) return ".gpkg";
  if (ascii.startsWith("fgb\x03")) return ".fgb";
  if (ascii.startsWith("{") || ascii.startsWith("[")) return ".geojson";
  if (/<kml[\s>]/i.test(ascii)) return ".kml";
  if (/<gpx[\s>]/i.test(ascii)) return ".gpx";
  return "";
}

function looksLikeHtml(contentType: string, head: Uint8Array): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const ascii = new TextDecoder("latin1").decode(head).trimStart().toLowerCase();
  return ascii.startsWith("<!doctype html") || ascii.startsWith("<html");
}

export async function fetchLayer(
  url: URL,
  options: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number | null) => void;
    accept?: "geodata" | "csv";
  } = {},
): Promise<File> {
  const { signal, onProgress, accept = "geodata" } = options;
  if (url.protocol === "http:" && location.protocol === "https:") {
    throw new FetchLayerError("Use an https:// link.");
  }

  let response: Response;
  try {
    response = await fetch(url, { signal, mode: "cors" });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new FetchLayerError(
      `${url.host} doesn't allow in-browser downloads (CORS). Download the file and drop it here instead.`,
    );
  }
  if (!response.ok) throw new FetchLayerError(`Server returned ${response.status}.`);

  const lengthHeader = response.headers.get("Content-Length");
  const total = lengthHeader ? Number(lengthHeader) || null : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, total);
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer());
    chunks.push(buf);
    loaded = buf.length;
    onProgress?.(loaded, total);
  }

  const head = (chunks[0] ?? new Uint8Array()).subarray(0, 64);
  const contentType = response.headers.get("Content-Type") ?? "";
  if (looksLikeHtml(contentType, head)) {
    throw new FetchLayerError(
      "This link opens a web page, not a data file. Use the file's direct download link.",
    );
  }

  const allowed = accept === "csv" ? CSV_EXTS : [...SINGLE_EXTS, ...SHP_EXTS, ".json", ".zip"];
  const candidates = [
    basename(new URL(response.url || url.href).pathname),
    basename(url.pathname),
    dispositionName(response.headers.get("Content-Disposition")),
  ];
  let name = candidates.find((n) => allowed.includes(extOf(n))) ?? "";
  // .json is accepted by the file picker but not by the loader, so treat it as GeoJSON.
  if (extOf(name) === ".json") name = name.slice(0, -5) + ".geojson";
  if (!name) {
    const stem = candidates.find(Boolean)?.replace(/\.[^.]*$/, "") || "layer";
    const inferred =
      accept === "csv"
        ? ".csv"
        : (CONTENT_TYPE_EXTS.find(([re]) => re.test(contentType))?.[1] ?? sniffExt(head));
    if (!inferred || !allowed.includes(inferred)) {
      throw new FetchLayerError(
        accept === "csv"
          ? "No supported file found. Link to a CSV file."
          : "No supported file found. Link to a GeoJSON, GeoParquet, GeoPackage, Shapefile ZIP, or other supported format.",
      );
    }
    name = stem + inferred;
  }

  return new File(chunks as BlobPart[], name, {
    type: contentType,
  });
}
