// Shared display formatting for issue-table area/length columns, used by
// topology-cleaner and detect's IssuesTable components.

export function fmtArea(m2: number): string {
  if (!Number.isFinite(m2)) return "—";
  if (m2 >= 1e6) return `${(m2 / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
  if (m2 >= 1) return `${Math.round(m2).toLocaleString()} m²`;
  return `${m2.toPrecision(2)} m²`;
}

export function fmtLength(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
  const units: [number, string][] = [
    [1000, "km"],
    [1, "m"],
    [0.01, "cm"],
    [0.001, "mm"],
  ];
  const [factor, label] = units.find(([f]) => m >= f) ?? [0.001, "mm"];
  return `${(m / factor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${label}`;
}
