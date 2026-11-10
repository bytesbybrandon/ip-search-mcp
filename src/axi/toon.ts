// All AXI stdout flows through this module (AXI principle 1: token-efficient TOON).

export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function toonValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[,"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface ListOptions {
  total?: number;
}

export function emitList(
  name: string,
  rows: Array<Record<string, unknown>>,
  fields: string[],
  options: ListOptions = {},
): string {
  const count =
    options.total !== undefined && options.total !== rows.length
      ? `${rows.length} of ${options.total} total`
      : String(rows.length);
  const header = `${name}[${count}]{${fields.join(",")}}:`;
  const lines = rows.map((row) => `  ${fields.map((field) => toonValue(row[field])).join(",")}`);
  return [header, ...lines].join("\n");
}

export function emitBlock(name: string, lines: string[]): string {
  return [`${name}[${lines.length}]:`, ...lines.map((line) => `  ${line}`)].join("\n");
}

export function emitKV(pairs: Array<[string, unknown]>): string {
  return pairs.map(([key, value]) => `${key}: ${value === undefined ? "" : String(value)}`).join("\n");
}

export interface Truncated {
  text: string;
  truncated: boolean;
  totalChars: number;
}

export function truncate(text: string, limit = 800): Truncated {
  if (text.length <= limit) return { text, truncated: false, totalChars: text.length };
  return { text: text.slice(0, limit), truncated: true, totalChars: text.length };
}

export function truncationNote(value: Truncated): string {
  return `  ... (truncated, ${value.totalChars} chars total)`;
}

/** Fold long cell text to one line so a row stays a row. */
export function cell(text: string | undefined, limit: number, full: boolean): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (full || flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}... (${flat.length} chars, --full)`;
}
