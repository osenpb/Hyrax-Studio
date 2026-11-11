export interface Tabular {
  headers: string[];
  rows: (string | null)[][];
}

export const MAX_IMPORT_ROWS = 200_000;

export const DELIMITERS = [",", ";", "\t", "|"] as const;

export function detectDelimiter(text: string): string {
  const head = text.slice(0, 20000).split(/\r?\n/).slice(0, 8);
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = head.filter((line) => line.length > 0).map((line) => splitOutsideQuotes(line, d));
    if (counts.length === 0) continue;
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.every((c) => c === first);
    const score = first + (consistent ? 1000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) count++;
  }
  return count;
}

/** CSV según RFC 4180: comillas, comillas dobles escapadas, saltos de línea dentro de campos. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let touched = false;

  const endField = () => {
    row.push(field);
    field = "";
    touched = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !touched) {
      quoted = true;
      touched = true;
    } else if (c === delimiter) endField();
    else if (c === "\r") {
      if (source[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else {
      field += c;
      touched = true;
    }
  }
  if (quoted) throw new Error("El CSV tiene unas comillas sin cerrar.");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Acepta un arreglo de objetos, un arreglo de arreglos (con la primera fila de encabezados) o NDJSON. */
export function parseJsonRows(text: string): Tabular {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    try {
      data = lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new Error("El archivo no es un JSON válido (se esperaba un arreglo de objetos o una línea JSON por fila).");
    }
  }
  if (!Array.isArray(data)) {
    throw new Error("El JSON debe ser un arreglo de objetos, por ejemplo [{\"id\": 1}, {\"id\": 2}].");
  }
  if (data.length > 0 && data.every((r) => Array.isArray(r))) {
    const [head, ...body] = data as unknown[][];
    return { headers: head.map((h) => String(h)), rows: body.map((r) => r.map(cellText)) };
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Todos los elementos del JSON deben ser objetos.");
    }
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows = data.map((item) => headers.map((h) => cellText((item as Record<string, unknown>)[h])));
  return { headers, rows };
}

export function csvToTabular(rows: string[][], hasHeader: boolean): Tabular {
  if (rows.length === 0) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): (string | null)[] => [...r, ...Array<string>(width - r.length).fill("")];
  if (hasHeader) {
    const [head, ...body] = rows.map(pad);
    const headers = (head as string[]).map((h, i) => (h.trim() === "" ? `columna_${i + 1}` : h.trim()));
    return { headers, rows: body };
  }
  return { headers: Array.from({ length: width }, (_, i) => `columna_${i + 1}`), rows: rows.map(pad) };
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Para cada columna de destino, el índice de la columna del archivo con el mismo nombre (o null). */
export function autoMap(targets: string[], headers: string[]): (number | null)[] {
  const used = new Set<number>();
  return targets.map((target) => {
    const exact = headers.findIndex((h, i) => !used.has(i) && h === target);
    const loose = exact >= 0 ? exact : headers.findIndex((h, i) => !used.has(i) && normalize(h) === normalize(target));
    if (loose >= 0) used.add(loose);
    return loose >= 0 ? loose : null;
  });
}

export interface MapOptions {
  emptyAsNull: boolean;
  trim: boolean;
}

/** Aplica la asignación columna-destino → columna-origen y devuelve solo las columnas asignadas. */
export function applyMapping(
  source: Tabular,
  targets: string[],
  mapping: (number | null)[],
  options: MapOptions,
): { columns: string[]; rows: (string | null)[][] } {
  const picked = targets.map((name, i) => ({ name, index: mapping[i] })).filter((p) => p.index !== null && p.index !== undefined);
  const convert = (value: string | null): string | null => {
    if (value === null) return null;
    const text = options.trim ? value.trim() : value;
    return options.emptyAsNull && text === "" ? null : text;
  };
  return {
    columns: picked.map((p) => p.name),
    rows: source.rows.map((row) => picked.map((p) => convert(row[p.index as number] ?? null))),
  };
}
