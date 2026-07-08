// crypto.randomUUID() is unavailable in some contexts (e.g. non-HTTPS), so fall back
// to a timestamp + random string — collision-resistant enough for a per-session id.
export function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
