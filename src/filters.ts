import type { ColumnFilter, FilterOp } from "./api";

const PREFIXES: { prefix: string; op: FilterOp }[] = [
  { prefix: ">=", op: "gte" },
  { prefix: "<=", op: "lte" },
  { prefix: "!=", op: "not_equals" },
  { prefix: "<>", op: "not_equals" },
  { prefix: ">", op: "gt" },
  { prefix: "<", op: "lt" },
  { prefix: "=", op: "equals" },
  { prefix: "^", op: "starts_with" },
];

export function parseFilter(column: string, text: string): ColumnFilter | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "=null") return { column, op: "is_null", value: null };
  if (lower === "!null" || lower === "not null" || lower === "!=null") {
    return { column, op: "not_null", value: null };
  }
  for (const { prefix, op } of PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return value ? { column, op, value } : null;
    }
  }
  return { column, op: "contains", value: trimmed };
}

export function parseFilters(inputs: Record<string, string>): ColumnFilter[] {
  return Object.entries(inputs)
    .map(([column, text]) => parseFilter(column, text))
    .filter((f): f is ColumnFilter => f !== null);
}
