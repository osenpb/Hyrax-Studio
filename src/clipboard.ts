type Cell = string | null;

function tsvField(value: Cell): string {
  if (value === null) return "";
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toTsv(columns: string[], rows: Cell[][]): string {
  const lines = [columns.map((c) => tsvField(c)).join("\t")];
  for (const row of rows) lines.push(row.map(tsvField).join("\t"));
  return lines.join("\n");
}

export function toJsonRows(columns: string[], rows: Cell[][]): string {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i] ?? null]))),
    null,
    2,
  );
}

export function tryParseJson(value: string | null): unknown {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
