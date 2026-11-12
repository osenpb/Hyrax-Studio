import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import { getLang, t } from "./i18n";

// Los nombres entre ${…} son los campos que se rellenan al expandir; se traducen con el resto de la interfaz.
const localize = (template: string) => template.replace(/\$\{(\w+)\}/g, (_m, word: string) => "${" + t(word) + "}");

const make = (label: string, detail: string, template: string): Completion =>
  snippetCompletion(localize(template), { label, detail: t(detail), type: "text", boost: -2 });

/** Plantillas que se expanden al escribir la abreviatura y pulsar Enter o Tab; Tab salta entre campos. */
const build = (): Completion[] => [
  make("sel", "SELECT … FROM … WHERE", "SELECT ${columnas}\nFROM ${tabla}\nWHERE ${condicion};"),
  make("selall", "SELECT * … LIMIT", "SELECT *\nFROM ${tabla}\nLIMIT ${100};"),
  make("cnt", "SELECT count(*)", "SELECT count(*)\nFROM ${tabla}\nWHERE ${condicion};"),
  make("ins", "INSERT INTO … VALUES", "INSERT INTO ${tabla} (${columnas})\nVALUES (${valores});"),
  make("upd", "UPDATE … SET … WHERE", "UPDATE ${tabla}\nSET ${columna} = ${valor}\nWHERE ${condicion};"),
  make("del", "DELETE FROM … WHERE", "DELETE FROM ${tabla}\nWHERE ${condicion};"),
  make("joini", "INNER JOIN … ON", "INNER JOIN ${tabla} ${alias} ON ${alias}.${columna} = ${otra}.${columna}"),
  make("joinl", "LEFT JOIN … ON", "LEFT JOIN ${tabla} ${alias} ON ${alias}.${columna} = ${otra}.${columna}"),
  make(
    "grp",
    "GROUP BY con conteo",
    "SELECT ${columna}, count(*)\nFROM ${tabla}\nGROUP BY ${columna}\nORDER BY count(*) DESC;",
  ),
  make(
    "dup",
    "Buscar duplicados",
    "SELECT ${columna}, count(*)\nFROM ${tabla}\nGROUP BY ${columna}\nHAVING count(*) > 1;",
  ),
  make("cte", "WITH … AS", "WITH ${nombre} AS (\n  SELECT ${columnas}\n  FROM ${tabla}\n)\nSELECT *\nFROM ${nombre};"),
  make("case", "CASE WHEN", "CASE WHEN ${condicion} THEN ${a} ELSE ${b} END"),
  make("coal", "coalesce()", "coalesce(${valor}, ${defecto})"),
  make("exp", "EXPLAIN ANALYZE", "EXPLAIN (ANALYZE, BUFFERS)\n${consulta};"),
  make(
    "crt",
    "CREATE TABLE",
    "CREATE TABLE ${tabla} (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${columna} text NOT NULL\n);",
  ),
  make("idx", "CREATE INDEX", "CREATE INDEX ${nombre} ON ${tabla} (${columna});"),
  make(
    "fk",
    "ADD FOREIGN KEY",
    "ALTER TABLE ${tabla}\n  ADD CONSTRAINT ${nombre} FOREIGN KEY (${columna})\n  REFERENCES ${otra} (${id});",
  ),
];

let cached: { lang: string; list: Completion[] } | null = null;

/** Las plantillas en el idioma actual (los nombres de los campos a rellenar también se traducen). */
export function snippets(): Completion[] {
  const lang = getLang();
  if (!cached || cached.lang !== lang) cached = { lang, list: build() };
  return cached.list;
}

