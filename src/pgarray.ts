/** Lee un arreglo unidimensional de PostgreSQL (`{a,"b c",NULL}`). Devuelve null si no es de una dimensión. */
export function parsePgArray(text: string): (string | null)[] | null {
  const s = text.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const body = s.slice(1, -1);
  if (body.trim() === "") return [];
  const items: (string | null)[] = [];
  let i = 0;
  while (i <= body.length) {
    while (body[i] === " ") i++;
    if (body[i] === "{") return null;
    let value = "";
    let quoted = false;
    if (body[i] === '"') {
      quoted = true;
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        value += body[i] ?? "";
        i++;
      }
      i++;
    } else {
      while (i < body.length && body[i] !== ",") {
        if (body[i] === "\\") i++;
        value += body[i] ?? "";
        i++;
      }
      value = value.trim();
    }
    items.push(!quoted && value.toUpperCase() === "NULL" ? null : value);
    while (body[i] === " ") i++;
    if (i >= body.length) break;
    if (body[i] !== ",") return null;
    i++;
  }
  return items;
}
