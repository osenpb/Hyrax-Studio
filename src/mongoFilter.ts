// Construye el filtro, el orden y la proyección de una consulta de MongoDB a partir de lo que escribe el usuario:
// JSON (si empieza por «{») o una sintaxis rápida sin llaves ni comillas.
//
//   filtro:      status=OPEN age>30 name~ana     →  {"status":"OPEN","age":{"$gt":30},"name":{"$regex":"ana","$options":"i"}}
//   orden:       -created name                   →  {"created":-1,"name":1}
//   proyección:  name email -_id                 →  {"name":1,"email":1,"_id":0}

function checkJson(text: string, what: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} no es un JSON válido.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} debe ser un objeto JSON, por ejemplo { "campo": "valor" }.`);
  }
  return text;
}

const OPS: Record<string, string> = { "!=": "$ne", ">=": "$gte", "<=": "$lte", ">": "$gt", "<": "$lt" };

function parseValue(field: string, raw: string): unknown {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
    return raw.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  if (field === "_id" && /^[0-9a-fA-F]{24}$/.test(raw)) return { $oid: raw.toLowerCase() };
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) {
    const iso = raw.includes("T") ? raw : `${raw}T00:00:00Z`;
    const date = new Date(iso.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z");
    if (!Number.isNaN(date.getTime())) return { $date: date.toISOString() };
  }
  return raw;
}

const TOKEN = /\s*([^\s=<>!~,"']+)\s*(!=|>=|<=|=|>|<|~)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,]+)/y;

/** Filtro: JSON tal cual, o condiciones rápidas separadas por espacios o comas. Vacío = sin filtro. */
export function buildFilter(input: string): string {
  const text = input.trim();
  if (text === "") return "";
  if (text.startsWith("{")) return checkJson(text, "El filtro");

  const filter: Record<string, unknown> = {};
  const used: Record<string, "eq" | "ops"> = {};
  let pos = 0;
  TOKEN.lastIndex = 0;
  while (pos < text.length) {
    const skip = /^[\s,]*/.exec(text.slice(pos))![0].length;
    pos += skip;
    if (pos >= text.length) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (!m) {
      throw new Error(
        `No entiendo «${text.slice(pos, pos + 24)}». Usa campo=valor, campo>5, campo~texto, o un JSON como { "campo": "valor" }.`,
      );
    }
    pos = TOKEN.lastIndex;
    const [, field, op, rawValue] = m;
    const value = parseValue(field, rawValue);

    if (op === "=") {
      if (field in used) throw new Error(`«${field}» aparece dos veces: no se puede combinar una igualdad con otra condición del mismo campo.`);
      filter[field] = value;
      used[field] = "eq";
      continue;
    }
    if (used[field] === "eq") throw new Error(`«${field}» ya tiene una igualdad: no se puede combinar con ${op}.`);
    const bucket = (filter[field] ??= {}) as Record<string, unknown>;
    used[field] = "ops";
    if (op === "~") {
      bucket.$regex = String(value);
      bucket.$options = "i";
    } else {
      bucket[OPS[op]] = value;
    }
  }
  return JSON.stringify(filter);
}

/** Orden: JSON, o campos separados por espacios o comas (`-campo` = descendente, `campo:-1` también vale). */
export function buildSort(input: string): string {
  const text = input.trim();
  if (text === "") return "";
  if (text.startsWith("{")) return checkJson(text, "El orden");
  const sort: Record<string, number> = {};
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const explicit = token.match(/^(.+):(-?1)$/);
    if (explicit) sort[explicit[1]] = Number(explicit[2]);
    else if (token.startsWith("-") && token.length > 1) sort[token.slice(1)] = -1;
    else if (/^[^:\s]+$/.test(token)) sort[token] = 1;
    else throw new Error(`No entiendo «${token}» en el orden. Usa campo, -campo o campo:-1.`);
  }
  return JSON.stringify(sort);
}

/** Proyección: JSON, o campos a mostrar (`-campo` los excluye; no se pueden mezclar, salvo `-_id`). */
export function buildProjection(input: string): string {
  const text = input.trim();
  if (text === "") return "";
  if (text.startsWith("{")) return checkJson(text, "La proyección");
  const projection: Record<string, number> = {};
  let includes = 0;
  let excludes = 0;
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    if (token.startsWith("-") && token.length > 1) {
      projection[token.slice(1)] = 0;
      if (token !== "-_id") excludes++;
    } else {
      projection[token] = 1;
      includes++;
    }
  }
  if (includes > 0 && excludes > 0) {
    throw new Error("MongoDB no permite mezclar campos incluidos y excluidos en una proyección (solo -_id se puede combinar).");
  }
  return JSON.stringify(projection);
}
