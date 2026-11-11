import { codeOnly } from "./sqlscan";

export interface ParamRef {
  name: string;
  from: number;
  to: number;
}

const START = /[A-Za-z_]/;
const WORD = /[A-Za-z0-9_]/;

/** Parámetros con nombre (`:id`) fuera de cadenas, comentarios, bloques `$$` y casts (`::int`). */
export function findParams(sql: string): ParamRef[] {
  const masked = Array.from(codeOnly(sql));
  const offsets = [0];
  let units = 0;
  for (const ch of sql) {
    units += ch.length;
    offsets.push(units);
  }
  const found: ParamRef[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ":") continue;
    const prev = masked[i - 1];
    const next = masked[i + 1];
    if (prev === ":" || next === ":" || next === undefined || !START.test(next)) continue;
    if (prev !== undefined && /[\w\])]/.test(prev)) continue;
    let end = i + 1;
    while (end < masked.length && WORD.test(masked[end])) end++;
    found.push({ name: masked.slice(i + 1, end).join(""), from: offsets[i], to: offsets[end] });
    i = end - 1;
  }
  return found;
}

export function uniqueParams(sql: string): string[] {
  return [...new Set(findParams(sql).map((p) => p.name))];
}

export function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  if (value.includes("\0")) throw new Error("El valor contiene un carácter nulo (NUL), que PostgreSQL no admite.");
  return value.includes("\\")
    ? `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "''")}'`;
}

export function substituteParams(sql: string, values: Record<string, string | null>): string {
  let out = sql;
  for (const ref of findParams(sql).reverse()) {
    const value = ref.name in values ? values[ref.name] : null;
    out = out.slice(0, ref.from) + sqlLiteral(value) + out.slice(ref.to);
  }
  return out;
}
