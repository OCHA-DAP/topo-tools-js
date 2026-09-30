<script lang="ts">
  import { REL_COLORS, REL_ORDER, type RelClass, type TableRow } from "./pipeline";

  let {
    rows = [],
    selectedClusterId = null,
    hoveredClusterId = null,
    hoveredFid = null,
    showSide = "b" as "a" | "b",
    visibleClasses = null,
    onRowHover,
    onToggleClass,
    onSetSide,
  }: {
    rows?: TableRow[];
    selectedClusterId?: number | null;
    hoveredClusterId?: number | null;
    hoveredFid?: number | null;
    showSide?: "a" | "b";
    visibleClasses?: Set<RelClass> | null;
    onRowHover?: (payload: { cluster_id: number | null; a_fid: number | null; b_fid: number | null } | null) => void;
    onToggleClass?: (c: RelClass) => void;
    onSetSide?: (side: "a" | "b") => void;
  } = $props();

  let search = $state("");

  // Filter rows by visibleClasses and free-text search. Searches across A/B
  // codes and names.
  const filteredRows = $derived.by(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (visibleClasses && !visibleClasses.has(r.relationship_class)) return false;
      if (!term) return true;
      const hay = [r.a_code, r.a_name, r.b_code, r.b_name]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .join(" ");
      return hay.includes(term);
    });
  });

  // Group rows by cluster_id. For each cluster, determine the rowspan to use
  // on each side. The "new" column rowspans across all rows for that cluster
  // when it's an N:1 merge (unique B fid, multiple A rows). Symmetric for splits.
  interface Cluster {
    cluster_id: number;
    relationship_class: RelClass;
    rows: TableRow[];
    aFidsUnique: number;
    bFidsUnique: number;
  }

  const clusters = $derived.by<Cluster[]>(() => {
    const map = new Map<number, Cluster>();
    for (const r of filteredRows) {
      let c = map.get(r.cluster_id);
      if (!c) {
        c = {
          cluster_id: r.cluster_id,
          relationship_class: r.relationship_class,
          rows: [],
          aFidsUnique: 0,
          bFidsUnique: 0,
        };
        map.set(r.cluster_id, c);
      }
      c.rows.push(r);
    }
    // Sort clusters: by relationship class (per REL_ORDER), then cluster_id.
    const out = Array.from(map.values());
    for (const c of out) {
      const aFids = new Set<number>();
      const bFids = new Set<number>();
      for (const r of c.rows) {
        if (r.a_fid != null) aFids.add(r.a_fid);
        if (r.b_fid != null) bFids.add(r.b_fid);
      }
      c.aFidsUnique = aFids.size;
      c.bFidsUnique = bFids.size;
    }
    out.sort((x, y) => {
      const xi = REL_ORDER.indexOf(x.relationship_class);
      const yi = REL_ORDER.indexOf(y.relationship_class);
      if (xi !== yi) return xi - yi;
      return x.cluster_id - y.cluster_id;
    });
    return out;
  });

  // For each cluster, precompute rowspans:
  //  - If aFids = 1 and bFids > 1 (split): the A cell spans bFids rows.
  //  - If aFids > 1 and bFids = 1 (merge): the B cell spans aFids rows.
  //  - Otherwise (1:1 or N:M complex), no rowspan.
  function rowspanForCluster(c: Cluster): "a" | "b" | "none" {
    if (c.aFidsUnique === 1 && c.bFidsUnique > 1) return "a";
    if (c.bFidsUnique === 1 && c.aFidsUnique > 1) return "b";
    return "none";
  }

  let scrollContainer: HTMLDivElement | undefined;
  let hoveredRowKey = $state<string | null>(null);

  interface TooltipState {
    x: number;
    y: number;
    cov_a: number | null;
    cov_b: number | null;
    iou: number | null;
    relClass: RelClass | null;
  }
  let tooltip = $state<TooltipState | null>(null);

  function handleMouseMove(e: MouseEvent): void {
    const tr = (e.target as Element).closest("tr[data-row-key]") as HTMLElement | null;
    if (!tr) {
      tooltip = null;
      return;
    }
    const covA = tr.dataset.covA ? Number(tr.dataset.covA) : null;
    const covB = tr.dataset.covB ? Number(tr.dataset.covB) : null;
    const iouV = tr.dataset.iou ? Number(tr.dataset.iou) : null;
    const relClass = (tr.dataset.relationshipClass as RelClass) ?? null;
    if (covA == null && covB == null) {
      tooltip = null;
      return;
    }
    tooltip = { x: e.clientX, y: e.clientY, cov_a: covA, cov_b: covB, iou: iouV, relClass };
  }

  // Map click sets selectedClusterId; scroll the matching row into view.
  $effect(() => {
    const id = selectedClusterId;
    if (id == null || !scrollContainer) return;
    const row = scrollContainer.querySelector<HTMLTableRowElement>(`tr[data-cluster-id="${id}"]`);
    row?.scrollIntoView({ block: "center" });
  });

  // Clicking a Version A/B cell switches the map to that side.
  function handleSideCell(side: "a" | "b"): void {
    onSetSide?.(side);
  }

  function parseFid(v: string | undefined): number | null {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function handleTableMouseover(e: MouseEvent): void {
    const tr = (e.target as Element).closest("tr[data-row-key]") as HTMLElement | null;
    const rowKey = tr?.dataset.rowKey ?? null;
    if (rowKey === hoveredRowKey) return;
    hoveredRowKey = rowKey;
    if (!tr) {
      onRowHover?.(null);
      return;
    }
    onRowHover?.({
      cluster_id: Number(tr.dataset.clusterId),
      a_fid: parseFid(tr.dataset.aFid),
      b_fid: parseFid(tr.dataset.bFid),
    });
  }

  function handleTableMouseleave(): void {
    if (hoveredRowKey === null) return;
    hoveredRowKey = null;
    onRowHover?.(null);
    tooltip = null;
  }

  function isFeatureHovered(r: TableRow): boolean {
    if (hoveredFid == null) return false;
    return (showSide === "a" ? r.a_fid : r.b_fid) === hoveredFid;
  }

  function isClusterFeatureHovered(c: Cluster): boolean {
    if (hoveredFid == null) return false;
    return c.rows.some((r) => (showSide === "a" ? r.a_fid : r.b_fid) === hoveredFid);
  }
</script>

<div class="cw-table">
  <div class="cw-table-toolbar">
    <input
      class="cw-search"
      placeholder="Search codes or names…"
      bind:value={search}
      aria-label="Search"
    />
    {#if visibleClasses && onToggleClass}
      <div class="cw-class-filters">
        {#each REL_ORDER as c (c)}
          <label class="cw-class-toggle">
            <input
              type="checkbox"
              checked={visibleClasses.has(c)}
              onchange={() => onToggleClass(c)}
            />
            <span class="cw-swatch" style="background:{REL_COLORS[c]}"></span>
            <span class="cw-class-name">{c}</span>
          </label>
        {/each}
      </div>
    {/if}
  </div>

  <div class="cw-table-scroll" bind:this={scrollContainer} onmousemove={handleMouseMove}>
    <table>
      <thead>
        <tr>
          <th>Class</th>
          <th>Version A code</th>
          <th>Version A name</th>
          <th>Version B code</th>
          <th>Version B name</th>
        </tr>
      </thead>
      <tbody onmouseover={handleTableMouseover} onmouseleave={handleTableMouseleave}>
        {#each clusters as c (c.cluster_id)}
          {@const span = rowspanForCluster(c)}
          {@const clusterHover = isClusterFeatureHovered(c)}
          {@const clusterAnchorA = clusterHover && span === "a"}
          {@const clusterAnchorB = clusterHover && span === "b"}
          {@const clusterRowHovered = c.rows.some((_, i) => hoveredRowKey === `${c.cluster_id}-${i}`)
            || (hoveredClusterId === c.cluster_id && hoveredRowKey === null && hoveredFid == null)}
          {#each c.rows as r, i (i)}
            {@const featureHover = isFeatureHovered(r)}
            {@const anchorA = featureHover}
            {@const anchorB = featureHover}
            <tr
              class="cw-row"
              class:cw-row-hovered={
                hoveredRowKey === `${c.cluster_id}-${i}` ||
                featureHover ||
                (hoveredClusterId === c.cluster_id && hoveredRowKey === null && hoveredFid == null)
              }
              data-row-key="{c.cluster_id}-{i}"
              data-cluster-id={c.cluster_id}
              data-a-fid={r.a_fid ?? ""}
              data-b-fid={r.b_fid ?? ""}
              data-relationship-class={c.relationship_class}
              data-cov-a={r.coverage_a ?? ""}
              data-cov-b={r.coverage_b ?? ""}
              data-iou={r.iou ?? ""}
            >
              {#if i === 0}
                <td
                  class="cw-class-cell"
                  class:cw-cell-cluster-hovered={clusterHover}
                  class:cw-class-cell-active={clusterRowHovered || clusterHover}
                  rowspan={c.rows.length}
                >
                  <span class="cw-class-badge" style="background:{REL_COLORS[c.relationship_class]}"
                  >{c.relationship_class}</span>
                </td>
              {/if}

              <!-- Previous side: A code & name -->
              {#if span === "a"}
                {#if i === 0}
                  <td rowspan={c.rows.length} class="cw-spanned" class:cw-cell-cluster-hovered={clusterHover} class:cw-cell-anchor={clusterAnchorA && showSide === "a"} class:cw-cell-anchor-light={clusterAnchorA && showSide !== "a"} onclick={() => handleSideCell("a")}>{r.a_code ?? "—"}</td>
                  <td rowspan={c.rows.length} class="cw-spanned" class:cw-cell-cluster-hovered={clusterHover} class:cw-cell-anchor={clusterAnchorA && showSide === "a"} class:cw-cell-anchor-light={clusterAnchorA && showSide !== "a"} onclick={() => handleSideCell("a")}>{r.a_name ?? "—"}</td>
                {/if}
              {:else}
                <td class:cw-cell-anchor={anchorA && showSide === "a"} class:cw-cell-anchor-light={anchorA && showSide !== "a"} onclick={() => handleSideCell("a")}>{r.a_code ?? "—"}</td>
                <td class:cw-cell-anchor={anchorA && showSide === "a"} class:cw-cell-anchor-light={anchorA && showSide !== "a"} onclick={() => handleSideCell("a")}>{r.a_name ?? "—"}</td>
              {/if}

              <!-- New side: B code & name -->
              {#if span === "b"}
                {#if i === 0}
                  <td rowspan={c.rows.length} class="cw-spanned" class:cw-cell-cluster-hovered={clusterHover} class:cw-cell-anchor={clusterAnchorB && showSide === "b"} class:cw-cell-anchor-light={clusterAnchorB && showSide !== "b"} onclick={() => handleSideCell("b")}>{r.b_code ?? "—"}</td>
                  <td rowspan={c.rows.length} class="cw-spanned" class:cw-cell-cluster-hovered={clusterHover} class:cw-cell-anchor={clusterAnchorB && showSide === "b"} class:cw-cell-anchor-light={clusterAnchorB && showSide !== "b"} onclick={() => handleSideCell("b")}>{r.b_name ?? "—"}</td>
                {/if}
              {:else}
                <td class:cw-cell-anchor={anchorB && showSide === "b"} class:cw-cell-anchor-light={anchorB && showSide !== "b"} onclick={() => handleSideCell("b")}>{r.b_code ?? "—"}</td>
                <td class:cw-cell-anchor={anchorB && showSide === "b"} class:cw-cell-anchor-light={anchorB && showSide !== "b"} onclick={() => handleSideCell("b")}>{r.b_name ?? "—"}</td>
              {/if}
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>

    {#if filteredRows.length === 0}
      <p class="cw-empty">No rows match the current filter.</p>
    {/if}
  </div>

  {#if tooltip && (tooltip.cov_a != null || tooltip.cov_b != null)}
    <div class="cw-tooltip" style="left:{tooltip.x + 14}px;top:{tooltip.y + 8}px">
      <div class="cw-tooltip-grid">
        {#if tooltip.cov_a != null}
          <span class="cw-tooltip-pct">{Math.round(tooltip.cov_a * 100)}%</span><span>A in B</span>
        {/if}
        {#if tooltip.cov_b != null}
          <span class="cw-tooltip-pct">{Math.round(tooltip.cov_b * 100)}%</span><span>B in A</span>
        {/if}
        {#if (tooltip.relClass === "unchanged" || tooltip.relClass === "renamed" || tooltip.relClass === "modified" || tooltip.relClass === "relocated") && tooltip.iou != null}
          <span class="cw-tooltip-pct">{Math.round(tooltip.iou * 100)}%</span><span>Similarity</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .cw-table {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cw-table-toolbar {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
  }
  .cw-search {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.875rem;
  }
  .cw-class-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .cw-class-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    cursor: pointer;
    text-transform: capitalize;
  }
  .cw-swatch {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 2px;
    border: 1px solid rgba(0, 0, 0, 0.1);
  }
  .cw-table-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead {
    position: sticky;
    top: 0;
    background: #f3f4f6;
    z-index: 1;
  }
  th,
  td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: middle;
  }
  th {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #4b5563;
  }
  .cw-row {
    cursor: pointer;
  }
  .cw-row:hover {
    background: #f9fafb;
  }
  .cw-row-hovered {
    background: #f0f9ff !important;
  }
  /* Cells that belong to a cluster whose hovered fid lives in a different
     <tr> via rowspan. Keeps the class badge + spanned side lit up when the
     user hovers a sibling row that doesn't contain them. */
  .cw-cell-cluster-hovered {
    background: #f0f9ff !important;
  }
  /* Anchor the selection/hover bar to the (rowspanned) class cell so it
     always sits next to the class badge — independent of which specific
     row in the cluster is selected or hovered. */
  .cw-class-cell-active {
    box-shadow: inset 3px 0 0 #6366f1;
  }
  .cw-class-cell {
    width: 1%;
    white-space: nowrap;
  }
  .cw-class-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .cw-spanned {
    border-left: 2px solid #a5b4fc;
    font-weight: 500;
  }
  /* Anchor cells: hovered row's cells on the version currently shown on the map.
     Defined after .cw-spanned so font-weight wins on spanned-anchor cells. */
  .cw-cell-anchor {
    background: #c7d2fe !important;
    font-weight: 600;
    color: #1e1b4b;
  }
  /* Lighter anchor: the same hovered row's cells on the OTHER version, so the
     correspondence is visible without competing with the active side. */
  .cw-cell-anchor-light {
    background: #e0e7ff !important;
    color: #312e81;
  }
  .cw-empty {
    padding: 1rem;
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
  }
  .cw-tooltip {
    position: fixed;
    background: #1f2937;
    color: #f9fafb;
    font-size: 0.72rem;
    line-height: 1.5;
    padding: 0.25rem 0.55rem;
    border-radius: 4px;
    pointer-events: none;
    z-index: 100;
    white-space: nowrap;
  }
  .cw-tooltip-grid {
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 0.4rem;
  }
  .cw-tooltip-pct {
    text-align: right;
  }
</style>
