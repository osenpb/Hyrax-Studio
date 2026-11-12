// Autocompletado de la barra de búsqueda de MongoDB. Las sugerencias salen de los documentos que ya están
// cargados (no hay consultas extra al servidor): campos con su ruta (`envio.ciudad`), operadores y valores.

import { cellText, describe, isContainer } from "./ejson";

type Doc = Record<string, unknown>;

export interface Suggestion {
  /** Lo que se ve en la lista. */
  label: string;
  /** Texto que reemplaza el tramo [from, to) del campo. */
  insert: string;
  detail?: string;
}

export interface SuggestResult {
  items: Suggestion[];
  from: number;
  to: number;
}

export interface FieldInfo {
  path: string;
  kinds: string[];
}

const KIND_LABEL: Record<string, string> = {
  String: "texto",
  Boolean: "booleano",
  Null: "null",
  Int32: "int",
  Int64: "long",
  Double: "double",
  Decimal128: "decimal",
  Number: "número",
  ObjectId: "ObjectId",
  Date: "fecha",
  Binary: "binario",
  Timestamp: "timestamp",
  RegExp: "regex",
  Array: "arreglo",
  Object: "documento",
};

const MAX_ITEMS = 12;

/** Campos presentes en los documentos (con su tipo), `_id` primero, hasta `maxDepth` niveles de anidación. */
export function collectFields(docs: Doc[], maxDepth = 3, max = 300): FieldInfo[] {
  const map = new Map<string, Set<string>>();
  const order: string[] = [];
  const add = (path: string, kind: string) => {
    let kinds = map.get(path);
    if (!kinds) {
      if (map.size >= max) return;
      kinds = new Set();
      map.set(path, kinds);
      order.push(path);
    }
    kinds.add(KIND_LABEL[kind] ?? kind);
  };
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value as Doc)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const kind = describe(v).kind;
      add(path, kind);
      if (depth >= maxDepth) continue;
      if (kind === "Object") walk(v, path, depth + 1);
      else if (kind === "Array") for (const item of (v as unknown[]).slice(0, 5)) if (describe(item).kind === "Object") walk(item, path, depth + 1);
    }
  };
  for (const doc of docs) walk(doc, "", 1);
  const rest = order.filter((p) => p !== "_id");
  return (map.has("_id") ? ["_id", ...rest] : rest).map((path) => ({ path, kinds: [...(map.get(path) ?? [])] }));
}

function valuesAt(value: unknown, parts: string[]): unknown[] {
  // Al llegar al campo, un arreglo de valores simples aporta cada elemento.
  if (parts.length === 0) return Array.isArray(value) ? value.flatMap((v) => valuesAt(v, [])) : [value];
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, parts));
  if (value === null || typeof value !== "object") return [];
  const [head, ...tail] = parts;
  const next = (value as Doc)[head];
  return next === undefined ? [] : valuesAt(next, tail);
}

/** Valores distintos de un campo (solo tipos simples), en orden de aparición. */
export function collectValues(docs: Doc[], path: string, max = MAX_ITEMS): string[] {
  const seen = new Set<string>();
  const parts = path.split(".");
  for (const doc of docs) {
    for (const v of valuesAt(doc, parts)) {
      if (isContainer(v)) continue;
      const text = cellText(v) ?? "null";
      if (text.length > 60) continue;
      seen.add(text);
      if (seen.size >= max * 4) break;
    }
  }
  return [...seen].slice(0, max);
}

/** Une documentos nuevos a la muestra (sin repetir por `_id`) y la acota. */
export function mergeSample(prev: Doc[], next: Doc[], max = 200): Doc[] {
  const seen = new Set(prev.map((d) => JSON.stringify(d._id ?? d)));
  const merged = [...prev];
  for (const d of next) {
    const key = JSON.stringify(d._id ?? d);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(d);
    }
  }
  return merged.slice(-max);
}

const OPERATORS: Suggestion[] = [
  { label: "=", insert: "=", detail: "igual a" },
  { label: "!=", insert: "!=", detail: "distinto de" },
  { label: ">", insert: ">", detail: "mayor que" },
  { label: ">=", insert: ">=", detail: "mayor o igual que" },
  { label: "<", insert: "<", detail: "menor que" },
  { label: "<=", insert: "<=", detail: "menor o igual que" },
  { label: "~", insert: "~", detail: "contiene (sin distinguir mayúsculas)" },
];

const JSON_OPERATORS: Suggestion[] = [
  ["$eq", "igual a"],
  ["$ne", "distinto de"],
  ["$gt", "mayor que"],
  ["$gte", "mayor o igual que"],
  ["$lt", "menor que"],
  ["$lte", "menor o igual que"],
  ["$in", "está en la lista"],
  ["$nin", "no está en la lista"],
  ["$exists", "el campo existe"],
  ["$regex", "expresión regular"],
  ["$and", "todas las condiciones"],
  ["$or", "alguna condición"],
  ["$nor", "ninguna condición"],
  ["$not", "niega una condición"],
  ["$elemMatch", "algún elemento del arreglo cumple"],
  ["$size", "tamaño del arreglo"],
  ["$type", "tipo BSON"],
].map(([label, detail]) => ({ label, insert: label, detail }));

function rank(items: { path: string }[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  return items
    .map((i) => i.path)
    .filter((path) => path.toLowerCase().includes(p))
    .sort((a, b) => {
      const as = a.toLowerCase().startsWith(p) ? 0 : 1;
      const bs = b.toLowerCase().startsWith(p) ? 0 : 1;
      return as - bs || a.length - b.length || a.localeCompare(b);
    });
}

function fieldItems(fields: FieldInfo[], prefix: string, make: (path: string) => string): Suggestion[] {
  const byPath = new Map(fields.map((f) => [f.path, f]));
  return rank(fields, prefix)
    .slice(0, MAX_ITEMS)
    .map((path) => ({ label: path, insert: make(path), detail: byPath.get(path)?.kinds.slice(0, 2).join(" · ") }));
}

/** Cita un valor si hace falta para la sintaxis rápida (espacios, comas, comillas u operadores). */
function quoteIfNeeded(value: string): string {
  return /[\s,"'=<>!~]/.test(value) || value === "" ? JSON.stringify(value) : value;
}

/** Límites del «token» (campo+operador+valor) que contiene el cursor: se separan por espacios o comas fuera de comillas. */
function tokenBounds(text: string, caret: number): { start: number; end: number } {
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < caret; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (/[\s,]/.test(c)) start = i + 1;
  }
  let end = caret;
  let q = quote;
  while (end < text.length) {
    const c = text[end];
    if (q) {
      if (c === "\\") end++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (/[\s,]/.test(c)) break;
    end++;
  }
  return { start, end: Math.min(end, text.length) };
}

const OP_SPLIT = /^([^=<>!~"']*?)(!=|>=|<=|=|>|<|~)([\s\S]*)$/;

/** Sugerencias dentro de un filtro JSON: claves y operadores en posición de clave, y valores tras los dos puntos. */
function suggestJson(text: string, caret: number, docs: Doc[], fieldsOnly = false): SuggestResult | null {
  const before = text.slice(0, caret);
  let open = -1;
  let inString = false;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      open = i;
    }
  }
  if (!inString) return null;

  const prefix = before.slice(open + 1);
  // Fin de la cadena: la siguiente comilla sin escapar, o el cursor si no está cerrada.
  let end = caret;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === "\\") end++;
    end++;
  }
  const closed = end < text.length && text[end] === '"';
  const to = Math.min(end, text.length);
  const tail = closed ? "" : '"';

  const beforeQuote = before.slice(0, open).replace(/\s+$/, "");
  const last = beforeQuote[beforeQuote.length - 1];
  const fields = collectFields(docs);

  if (last === "{" || last === ",") {
    if (prefix.startsWith("$")) {
      if (fieldsOnly) return null;
      const items = JSON_OPERATORS.filter((o) => o.label.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, MAX_ITEMS)
        .map((o) => ({ ...o, insert: o.insert + tail }));
      return items.length ? { items, from: open + 1, to } : null;
    }
    const items = fieldItems(fields, prefix, (p) => p + tail);
    return items.length ? { items, from: open + 1, to } : null;
  }

  if (last === ":" || last === "[") {
    const key = /"([^"]+)"\s*:$/.exec(beforeQuote)?.[1];
    if (!key || fieldsOnly) return null;
    const values = collectValues(docs, key).filter((v) => v.toLowerCase().startsWith(prefix.toLowerCase()) && v !== "null");
    const items = values.map((v) => ({ label: v, insert: v.replace(/["\\]/g, "\\$&") + tail }));
    return items.length ? { items, from: open + 1, to } : null;
  }
  return null;
}

/**
 * Sugerencias para el filtro. En la sintaxis rápida: campos → operadores → valores. En JSON: claves, operadores y
 * valores dentro de las comillas. `force` (Ctrl+Espacio) muestra campos aunque todavía no se haya escrito nada.
 */
export function suggestFilter(text: string, caret: number, docs: Doc[], force = false): SuggestResult | null {
  if (text.trimStart().startsWith("{")) return suggestJson(text, caret, docs);
  const { start, end } = tokenBounds(text, caret);
  const prefix = text.slice(start, caret);
  const split = OP_SPLIT.exec(prefix);

  if (split) {
    const [, field, op, rawValue] = split;
    if (field === "") return null;
    const valuePrefix = rawValue.replace(/^["']/, "").toLowerCase();
    const values = collectValues(docs, field).filter((v) => v.toLowerCase().startsWith(valuePrefix));
    const from = start + field.length + op.length;
    const items = values
      .filter((v) => !(valuePrefix !== "" && v.toLowerCase() === valuePrefix && !rawValue.startsWith('"')))
      .map((v) => ({ label: v, insert: quoteIfNeeded(v) }));
    return items.length ? { items, from, to: end } : null;
  }

  if (prefix === "" && !force) return null;
  const fields = collectFields(docs);
  const exact = fields.find((f) => f.path === prefix);
  if (exact) {
    // El campo está completo: se ofrecen los operadores (y los demás campos que lo contienen).
    const ops = OPERATORS.map((o) => ({ label: `${prefix} ${o.label}`, insert: prefix + o.insert, detail: o.detail }));
    const more = fieldItems(fields, prefix, (p) => p + "=").filter((i) => i.label !== prefix);
    return { items: [...ops, ...more].slice(0, MAX_ITEMS + OPERATORS.length), from: start, to: end };
  }
  const items = fieldItems(fields, prefix, (p) => p + "=");
  return items.length ? { items, from: start, to: end } : null;
}

/** Sugerencias de campos para el orden y la proyección (admiten el prefijo `-`). */
export function suggestFields(text: string, caret: number, docs: Doc[], force = false): SuggestResult | null {
  if (text.trimStart().startsWith("{")) return suggestJson(text, caret, docs, true);
  const { start, end } = tokenBounds(text, caret);
  const raw = text.slice(start, caret);
  const sign = raw.startsWith("-") ? "-" : "";
  const prefix = raw.slice(sign.length);
  if (prefix === "" && !force && sign === "") return null;
  if (/[:]/.test(prefix)) return null;
  const items = fieldItems(collectFields(docs), prefix, (p) => sign + p);
  return items.length ? { items, from: start, to: end } : null;
}
