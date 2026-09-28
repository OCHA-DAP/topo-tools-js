// Admin-hierarchy column matching against `{n}`-templated field names, by name only.
// Ports topo-tools-py's core/admin_columns.py.

const NAME = 0;
const OTHER = 1;
const CODE = 2;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fieldPrefix(template: string): string {
  return template.split("{n}")[0];
}

// Matches a template's own column and its numbered siblings (`adm2_name1`, `GID_2_1`).
function familyPattern(template: string): RegExp {
  const i = template.indexOf("{n}");
  const before = i < 0 ? template : template.slice(0, i);
  const after = i < 0 ? "" : template.slice(i + 3);
  const sep = !after || /\d$/.test(after) ? "_" : "";
  return new RegExp(`^${escapeRegExp(before)}(\\d+)${escapeRegExp(after)}(?:${sep}(\\d+))?$`);
}

// Deepest level first (names, other, codes), then the rest in input order; also
// returns the deepest level's own code column to sort rows by, if any.
export function canonicalOrder(
  columns: string[],
  nameField: string,
  codeField: string,
): { ordered: string[]; sortColumn: string | null } {
  const nameRe = familyPattern(nameField);
  const codeRe = familyPattern(codeField);
  const prefix = fieldPrefix(codeField);
  const levelRe = prefix ? new RegExp(`^${escapeRegExp(prefix)}(\\d+)(?!\\d)`) : null;
  const keys = new Map<string, [number, number, number]>();
  for (const column of columns) {
    let m: RegExpExecArray | null;
    if ((m = codeRe.exec(column))) keys.set(column, [Number(m[1]), CODE, Number(m[2] ?? 0)]);
    else if ((m = nameRe.exec(column))) keys.set(column, [Number(m[1]), NAME, Number(m[2] ?? 0)]);
  }
  const levels = new Set([...keys.values()].map(([level]) => level));
  columns.forEach((column, position) => {
    const m = keys.has(column) || !levelRe ? null : levelRe.exec(column);
    if (m && levels.has(Number(m[1]))) keys.set(column, [Number(m[1]), OTHER, position]);
  });
  const ordered = [...keys.keys()].sort((a, b) => {
    const [la, ka, sa] = keys.get(a)!;
    const [lb, kb, sb] = keys.get(b)!;
    return lb - la || ka - kb || sa - sb;
  });
  const codes = new Map<number, string>();
  for (const [column, [level]] of keys) {
    if (column === codeField.replaceAll("{n}", String(level))) codes.set(level, column);
  }
  const sortColumn = codes.size > 0 ? codes.get(Math.max(...codes.keys()))! : null;
  return { ordered: [...ordered, ...columns.filter((c) => !keys.has(c))], sortColumn };
}
