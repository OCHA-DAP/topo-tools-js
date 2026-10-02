export function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

export function reversed(s: string): string {
  return [...s].reverse().join("");
}

// The run every name shares at the start, then at the end.
export function commonPrefixSuffix(names: string[]): [string, string] {
  const prefix = commonPrefix(names);
  const remainders = names.map((n) => reversed(n.slice(prefix.length)));
  return [prefix, reversed(commonPrefix(remainders))];
}
