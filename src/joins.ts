import type { ForeignKey } from "./api";
import { codeOnly } from "./sqlscan";

export interface TableRef {
  schema: string | null;
  table: string;
  alias: string | null;
}

export interface JoinSuggestion {
  label: string;
  detail: string;
  insert: string;
}

const NOT_ALIAS = new Set([
  "on", "where", "join", "inner", "left", "right", "full", "cross", "natural", "group", "order", "limit",
  "offset", "having", "union", "intersect", "except", "using", "lateral", "returning", "set", "values", "select",
  "fetch", "for", "window", "outer",
]);

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);

/** Tablas que aparecen tras FROM / JOIN en una sentencia, con su alias si lo tienen. */
export function tablesIn(statement: string): TableRef[] {
  const code = codeOnly(statement);
  const re = /\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?("[^"]+"|[A-Za-z_][\w$]*))?/gi;
  const refs: TableRef[] = [];
  for (const m of code.matchAll(re)) {
    const parts = m[1].split(".").map((p) => unquote(p.trim()));
    const alias = m[2] && !NOT_ALIAS.has(unquote(m[2]).toLowerCase()) ? unquote(m[2]) : null;
    refs.push(
      parts.length === 2
        ? { schema: parts[0], table: parts[1], alias }
        : { schema: null, table: parts[0], alias },
    );
  }
  return refs;
}

const ident = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

function makeAlias(table: string, taken: Set<string>): string {
  const base = (table.split("_").map((p) => p[0]).join("") || table[0] || "t").toLowerCase().slice(0, 3);
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
  return alias;
}

/** Tablas que se pueden unir con las ya presentes, según las claves foráneas, con su condición ON. */
export function joinSuggestions(statement: string, fks: ForeignKey[]): JoinSuggestion[] {
  const present = tablesIn(statement);
  if (present.length === 0) return [];
  const taken = new Set(present.map((p) => (p.alias ?? p.table).toLowerCase()));
  const out: JoinSuggestion[] = [];
  const seen = new Set<string>();

  const matches = (ref: TableRef, schema: string, table: string) =>
    ref.table === table && (ref.schema === null || ref.schema === schema);

  for (const ref of present) {
    const left = ref.alias ?? ref.table;
    for (const fk of fks) {
      let other: { schema: string; table: string } | null = null;
      let pairs: [string, string][] = [];
      if (matches(ref, fk.schema, fk.table)) {
        other = { schema: fk.refSchema, table: fk.refTable };
        pairs = fk.columns.map((c, i): [string, string] => [c, fk.refColumns[i]]);
      } else if (matches(ref, fk.refSchema, fk.refTable)) {
        other = { schema: fk.schema, table: fk.table };
        pairs = fk.refColumns.map((c, i): [string, string] => [c, fk.columns[i]]);
      }
      if (!other) continue;
      const key = `${other.schema}.${other.table}|${left}|${fk.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const alias = makeAlias(other.table, taken);
      const target = other.schema === "public" ? ident(other.table) : `${ident(other.schema)}.${ident(other.table)}`;
      const on = pairs.map(([mine, theirs]) => `${alias}.${ident(theirs)} = ${left}.${ident(mine)}`).join(" AND ");
      out.push({
        label: other.table,
        detail: `FK ${fk.name}`,
        insert: `${target} ${alias} ON ${on}`,
      });
    }
  }
  return out;
}
