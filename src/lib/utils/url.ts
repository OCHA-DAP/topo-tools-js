export function getUrlParam(key: string): string | null {
  return new URLSearchParams(location.search).get(key);
}

// replaceState, not pushState, so syncing a setting adds no history entry.
export function setUrlParam(key: string, value: string | null): void {
  const page = new URL(location.href);
  if (value === null) page.searchParams.delete(key);
  else page.searchParams.set(key, value);
  history.replaceState(history.state, "", page);
}
