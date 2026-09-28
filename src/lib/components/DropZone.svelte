<script lang="ts">
  import { onMount } from "svelte";
  import { unzip } from "fflate";
  import { CSV_EXTS, SHP_EXTS, SINGLE_EXTS, extOf } from "$lib/utils/formats";
  import { FetchLayerError, fetchLayer, parseHttpUrl } from "$lib/utils/fetchLayer";

  let {
    files = $bindable<File[]>([]),
    disabled = false,
    helpText = "GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)",
    disabledMessage,
    accept = "geodata",
    urlParam,
  }: {
    files?: File[];
    disabled?: boolean;
    helpText?: string;
    disabledMessage?: string;
    accept?: "geodata" | "csv";
    urlParam?: string;
  } = $props();

  let dragging = $state(false);
  let urlText = $state("");
  let fetching = $state(false);
  let progress = $state<{ name: string; loaded: number; total: number | null }>({
    name: "",
    loaded: 0,
    total: null,
  });
  let urlError = $state("");
  let sourceHost = $state("");
  let loadedUrl: URL | null = null;
  let controller: AbortController | null = null;

  const busy = $derived(disabled || fetching);
  const urlValid = $derived(parseHttpUrl(urlText) !== null);

  function isIncluded(file: File): boolean {
    const e = extOf(file.name);
    if (accept === "csv") return CSV_EXTS.includes(e);
    return SINGLE_EXTS.includes(e) || SHP_EXTS.includes(e);
  }

  function sortKey(file: File): string {
    return (
      (file as File & { webkitRelativePath: string }).webkitRelativePath ||
      file.name
    );
  }

  function filterAndSort(fileList: File[]): File[] {
    return fileList
      .filter(isIncluded)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }

  function summarize(fileList: File[]): string {
    const shpStems = new Map<string, string>();
    const singles: string[] = [];
    for (const f of fileList) {
      const relPath =
        (f as File & { webkitRelativePath: string }).webkitRelativePath || "";
      const lname = f.name.toLowerCase();
      if (SHP_EXTS.some((e) => lname.endsWith(e))) {
        const fullPath = relPath || f.name;
        const stem = fullPath.slice(0, fullPath.lastIndexOf(".")).toLowerCase();
        if (lname.endsWith(".shp") || !shpStems.has(stem)) {
          shpStems.set(
            stem,
            lname.endsWith(".shp") ? f.name : stem.split("/").pop()! + ".shp",
          );
        }
        continue;
      }
      singles.push(f.name);
    }
    return [...singles, ...Array.from(shpStems.values()).sort()].join(", ");
  }

  async function extractZip(file: File): Promise<File[]> {
    const data = new Uint8Array(await file.arrayBuffer());
    const entries = await new Promise<Record<string, Uint8Array>>(
      (resolve, reject) => {
        unzip(data, (err, result) => (err ? reject(err) : resolve(result)));
      },
    );
    const extracted: File[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
      if (path.startsWith("__MACOSX/") || bytes.length === 0) continue;
      const name = path.split("/").pop()!;
      const inner = new File([bytes.slice()], name);
      Object.defineProperty(inner, "webkitRelativePath", {
        value: path,
        writable: false,
        configurable: true,
        enumerable: true,
      });
      extracted.push(inner);
    }
    return extracted;
  }

  async function expandZips(fileList: File[]): Promise<File[]> {
    const result: File[] = [];
    for (const file of fileList) {
      if (extOf(file.name) === ".zip") {
        result.push(...(await extractZip(file)));
      } else {
        result.push(file);
      }
    }
    return result;
  }

  async function readEntry(
    entry: FileSystemEntry,
    basePath = "",
  ): Promise<File[]> {
    if (entry.isFile) {
      const f = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      const path = basePath ? `${basePath}/${f.name}` : f.name;
      const data = new Uint8Array(await f.arrayBuffer());
      const located = new File([data], f.name, {
        type: f.type,
        lastModified: f.lastModified,
      });
      Object.defineProperty(located, "webkitRelativePath", {
        value: path,
        writable: false,
        configurable: true,
        enumerable: true,
      });
      return [located];
    } else if (entry.isDirectory) {
      const newBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        const results: FileSystemEntry[] = [];
        function readBatch() {
          reader.readEntries((batch) => {
            if (batch.length === 0) resolve(results);
            else {
              results.push(...batch);
              readBatch();
            }
          });
        }
        readBatch();
      });
      const nested = await Promise.all(
        entries.map((e) => readEntry(e, newBase)),
      );
      return nested.flat();
    }
    return [];
  }

  function syncUrlParam(url: URL | null) {
    if (!urlParam) return;
    const page = new URL(location.href);
    if (url) page.searchParams.set(urlParam, url.href);
    else page.searchParams.delete(urlParam);
    history.replaceState(history.state, "", page);
  }

  function setLocalFiles(fileList: File[]) {
    files = fileList;
    sourceHost = "";
    loadedUrl = null;
    urlError = "";
    syncUrlParam(null);
  }

  function formatMB(bytes: number): string {
    return (bytes / 1e6).toFixed(1);
  }

  async function loadFromUrl(text: string) {
    const url = parseHttpUrl(text);
    if (!url || fetching) return;
    controller = new AbortController();
    fetching = true;
    urlError = "";
    progress = {
      name: url.pathname.split("/").pop() || url.host,
      loaded: 0,
      total: null,
    };
    try {
      const file = await fetchLayer(url, {
        signal: controller.signal,
        accept,
        onProgress: (loaded, total) => {
          progress.loaded = loaded;
          progress.total = total;
        },
      });
      const loaded = filterAndSort(await expandZips([file]));
      if (loaded.length === 0) {
        throw new FetchLayerError("No supported file found in the downloaded archive.");
      }
      files = loaded;
      sourceHost = url.host;
      loadedUrl = url;
      syncUrlParam(url);
    } catch (e) {
      syncUrlParam(loadedUrl);
      if (!controller.signal.aborted) {
        urlError =
          e instanceof FetchLayerError ? e.message : "Couldn't read the downloaded file.";
        if (!(e instanceof FetchLayerError)) console.error("Failed to load URL:", e);
      }
    } finally {
      fetching = false;
      controller = null;
    }
  }

  function handleUrlSubmit(event: SubmitEvent) {
    event.preventDefault();
    loadFromUrl(urlText);
  }

  function handleUrlPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!parseHttpUrl(text)) return;
    event.preventDefault();
    urlText = text.trim();
    loadFromUrl(urlText);
  }

  onMount(() => {
    const initial = urlParam && new URLSearchParams(location.search).get(urlParam);
    if (initial) {
      urlText = initial;
      loadFromUrl(initial);
    }
  });

  function handleDragOver(event: DragEvent) {
    if (busy) return;
    event.preventDefault();
    dragging = true;
  }

  function handleDragLeave(event: DragEvent) {
    const zone = event.currentTarget as HTMLElement;
    if (!zone.contains(event.relatedTarget as Node)) dragging = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (busy) return;
    dragging = false;
    const items = Array.from(event.dataTransfer?.items ?? []);
    const entries = items
      .map((item) => item.webkitGetAsEntry())
      .filter(Boolean) as FileSystemEntry[];
    try {
      let allFiles: File[];
      if (entries.length > 0) {
        allFiles = (await Promise.all(entries.map((e) => readEntry(e)))).flat();
      } else {
        // Fallback for synthetic drops (e.g. Playwright) that populate dataTransfer.files
        // but not the FileSystem Entries API
        allFiles = Array.from(event.dataTransfer?.files ?? []);
      }
      if (allFiles.length === 0) {
        const link = (event.dataTransfer?.getData("text/uri-list") ?? "")
          .split(/\r?\n/)
          .find((l) => l && !l.startsWith("#"));
        if (link && parseHttpUrl(link)) {
          urlText = link.trim();
          await loadFromUrl(urlText);
        }
        return;
      }
      setLocalFiles(filterAndSort(await expandZips(allFiles)));
    } catch (e) {
      console.error("Failed to read dropped files:", e);
    }
  }

  async function handleBrowse(event: Event) {
    const input = event.target as HTMLInputElement;
    setLocalFiles(filterAndSort(await expandZips(Array.from(input.files ?? []))));
  }
</script>

<div
  class="drop-zone"
  class:dragging
  class:disabled
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="region"
  aria-label="File upload drop zone"
>
  <p class="drop-message">
    {disabled && disabledMessage && files.length === 0 ? disabledMessage : "Drop a file here"}
  </p>
  <label class="browse-label">
    <input
      type="file"
      accept={accept === "csv"
        ? CSV_EXTS.join(",")
        : [...SINGLE_EXTS, ".json", ...SHP_EXTS, ".zip"].join(",")}
      multiple
      onchange={handleBrowse}
      disabled={busy}
      class="file-input"
    />
    <span class="browse-link">or browse</span>
  </label>

  {#if fetching}
    <p class="url-status" aria-live="polite">
      Downloading {progress.name}… {formatMB(progress.loaded)}{progress.total
        ? ` / ${formatMB(progress.total)}`
        : ""} MB
      <button type="button" class="cancel-link" onclick={() => controller?.abort()}>
        Cancel
      </button>
    </p>
  {:else}
    <form class="url-row" onsubmit={handleUrlSubmit}>
      <input
        type="url"
        class="url-input"
        placeholder="or paste a URL…"
        aria-label="Layer URL"
        bind:value={urlText}
        onpaste={handleUrlPaste}
        {disabled}
      />
      <button type="submit" class="url-load" disabled={disabled || !urlValid}>Load</button>
    </form>
  {/if}
  {#if urlError}
    <p class="url-error" role="alert">{urlError}</p>
  {/if}

  <p class="hint">{helpText}</p>

  {#if files.length > 0}
    <p class="file-list">
      <span class="filenames">{summarize(files)}</span>
      {#if sourceHost}<span class="source-host">from {sourceHost}</span>{/if}
    </p>
  {/if}
</div>

<style>
  .drop-zone {
    border: 2px dashed #9ca3af;
    border-radius: 8px;
    padding: 1.5rem 1rem;
    text-align: center;
    transition:
      border-color 0.15s,
      background-color 0.15s;
    background: #f9fafb;
  }
  .drop-zone.dragging {
    border-color: #1d4ed8;
    background: #eff6ff;
  }
  .drop-zone.disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .drop-message {
    margin: 0 0 0.25rem;
    font-size: 0.95rem;
    color: #374151;
  }
  .hint {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: #9ca3af;
  }
  .browse-label {
    display: inline-block;
    cursor: pointer;
  }
  .file-input {
    position: absolute;
    opacity: 0;
    width: 0.1px;
    height: 0.1px;
    overflow: hidden;
  }
  .browse-link {
    font-size: 0.875rem;
    color: #1d4ed8;
    text-decoration: underline;
    cursor: pointer;
  }
  .browse-label:focus-within .browse-link {
    outline: 2px solid #1d4ed8;
    outline-offset: 2px;
    border-radius: 2px;
  }
  .file-list {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
    color: #374151;
  }
  .filenames {
    font-family: monospace;
    color: #111;
    word-break: break-all;
  }
  .source-host {
    margin-left: 0.4rem;
    color: #6b7280;
  }
  .url-row {
    display: flex;
    gap: 0.4rem;
    max-width: 28rem;
    margin: 0.6rem auto 0;
  }
  .url-input {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    font-size: 0.85rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    background: #fff;
  }
  .url-input:focus {
    outline: 2px solid #1d4ed8;
    outline-offset: -1px;
    border-color: #1d4ed8;
  }
  .url-load {
    padding: 0.3rem 0.8rem;
    font-size: 0.85rem;
    border: 1px solid #1d4ed8;
    border-radius: 4px;
    background: #1d4ed8;
    color: #fff;
    cursor: pointer;
  }
  .url-load:disabled {
    border-color: #d1d5db;
    background: #e5e7eb;
    color: #9ca3af;
    cursor: default;
  }
  .url-status {
    margin: 0.6rem 0 0;
    font-size: 0.85rem;
    color: #374151;
  }
  .cancel-link {
    margin-left: 0.4rem;
    padding: 0;
    border: none;
    background: none;
    font-size: 0.85rem;
    color: #1d4ed8;
    text-decoration: underline;
    cursor: pointer;
  }
  .url-error {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #b91c1c;
  }
</style>
