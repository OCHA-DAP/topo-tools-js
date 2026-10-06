// Spaces and invisible characters a reviewer can't see are shown as markers.
export function visible(s: string | null): string {
  if (s === null) return "";
  return s
    .replace(/[\u0000-\u001f\u007f-\u00a0\u00ad\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]/g, (c) =>
      c === " " ? c : `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
    )
    .replace(/^ | $/g, "␣")
    .replace(/ {2,}/g, (m) => "␣".repeat(m.length));
}
