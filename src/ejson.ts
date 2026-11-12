// Lectura de documentos de MongoDB en JSON extendido canónico (lo que devuelve el backend).
// Conserva los tipos BSON: {"$numberInt":"5"} es un Int32, {"$oid":"…"} un ObjectId, etc.

export type BsonKind =
  | "String"
  | "Boolean"
  | "Null"
  | "Int32"
  | "Int64"
  | "Double"
  | "Decimal128"
  | "Number"
  | "ObjectId"
  | "Date"
  | "Binary"
  | "Timestamp"
  | "RegExp"
  | "MinKey"
  | "MaxKey"
  | "Undefined"
  | "Symbol"
  | "Code"
  | "Array"
  | "Object";

export interface Described {
  kind: BsonKind;
  /** Texto para mostrar (solo en tipos simples; en Array y Object es un resumen). */
  text: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isoFromMillis(ms: string): string {
  const n = Number(ms);
  const d = new Date(n);
  return Number.isFinite(n) && !Number.isNaN(d.getTime()) ? d.toISOString() : ms;
}

/** Clasifica un valor: tipo BSON y texto. Los contenedores (Array y Object) llevan un resumen en `text`. */
export function describe(value: unknown): Described {
  if (value === null) return { kind: "Null", text: "null" };
  if (typeof value === "string") return { kind: "String", text: value };
  if (typeof value === "boolean") return { kind: "Boolean", text: String(value) };
  if (typeof value === "number") return { kind: "Number", text: String(value) };
  if (Array.isArray(value)) return { kind: "Array", text: `[${value.length}]` };
  if (!isPlainObject(value)) return { kind: "String", text: String(value) };

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [key] = keys;
    const inner = value[key];
    switch (key) {
      case "$oid":
        return { kind: "ObjectId", text: String(inner) };
      case "$date":
        if (typeof inner === "string") return { kind: "Date", text: inner };
        if (isPlainObject(inner) && typeof inner.$numberLong === "string") {
          return { kind: "Date", text: isoFromMillis(inner.$numberLong) };
        }
        break;
      case "$numberInt":
        return { kind: "Int32", text: String(inner) };
      case "$numberLong":
        return { kind: "Int64", text: String(inner) };
      case "$numberDouble":
        return { kind: "Double", text: String(inner) };
      case "$numberDecimal":
        return { kind: "Decimal128", text: String(inner) };
      case "$binary":
        if (isPlainObject(inner)) {
          const b64 = String(inner.base64 ?? "");
          const sub = String(inner.subType ?? "00");
          const label = sub === "04" ? "UUID" : `Binary(${sub})`;
          return { kind: "Binary", text: `${label} ${b64.length > 32 ? b64.slice(0, 32) + "…" : b64}` };
        }
        break;
      case "$timestamp":
        if (isPlainObject(inner)) return { kind: "Timestamp", text: `Timestamp(${inner.t}, ${inner.i})` };
        break;
      case "$regularExpression":
        if (isPlainObject(inner)) return { kind: "RegExp", text: `/${inner.pattern}/${inner.options ?? ""}` };
        break;
      case "$minKey":
        return { kind: "MinKey", text: "MinKey" };
      case "$maxKey":
        return { kind: "MaxKey", text: "MaxKey" };
      case "$undefined":
        return { kind: "Undefined", text: "undefined" };
      case "$symbol":
        return { kind: "Symbol", text: String(inner) };
      case "$code":
        return { kind: "Code", text: String(inner) };
    }
  }
  return { kind: "Object", text: `{${keys.length}}` };
}

/** Un valor es un contenedor navegable (documento o arreglo), no un tipo simple de BSON. */
export function isContainer(value: unknown): boolean {
  const k = describe(value).kind;
  return k === "Array" || k === "Object";
}

function short(value: unknown, depth: number): string {
  const d = describe(value);
  if (d.kind === "String") return JSON.stringify(d.text.length > 30 ? d.text.slice(0, 30) + "…" : d.text);
  if (d.kind === "Array") {
    if (depth <= 0) return d.text;
    return `[${(value as unknown[]).slice(0, 4).map((v) => short(v, depth - 1)).join(", ")}${(value as unknown[]).length > 4 ? ", …" : ""}]`;
  }
  if (d.kind === "Object") {
    if (depth <= 0) return d.text;
    const entries = Object.entries(value as Record<string, unknown>);
    return `{ ${entries.slice(0, 3).map(([k, v]) => `${k}: ${short(v, depth - 1)}`).join(", ")}${entries.length > 3 ? ", …" : ""} }`;
  }
  return d.text;
}

/** Texto de una celda de la rejilla: los tipos simples tal cual y los contenedores resumidos. */
export function cellText(value: unknown): string | null {
  if (value === undefined) return null; // el documento no tiene ese campo
  const d = describe(value);
  if (d.kind === "Null") return null;
  if (d.kind === "Array" || d.kind === "Object") {
    const text = short(value, 2);
    return text.length > 120 ? text.slice(0, 120) + "…" : text;
  }
  return d.text;
}

/** Columnas de una página de documentos: `_id` primero y luego los campos por orden de aparición. */
export function columnsOf(docs: Record<string, unknown>[], max = 60): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  const rest = order.filter((k) => k !== "_id");
  return (seen.has("_id") ? ["_id", ...rest] : rest).slice(0, max);
}
