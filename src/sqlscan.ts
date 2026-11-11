export function codeOnly(sql: string): string {
  const chars = Array.from(sql);
  const n = chars.length;
  const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  let out = "";
  let i = 0;

  while (i < n) {
    const c = chars[i];
    const next = chars[i + 1];

    if (c === "-" && next === "-") {
      while (i < n && chars[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      let depth = 0;
      while (i < n) {
        if (chars[i] === "/" && chars[i + 1] === "*") {
          depth++;
          out += "  ";
          i += 2;
        } else if (chars[i] === "*" && chars[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
          if (depth === 0) break;
        } else {
          out += blank(chars[i]);
          i++;
        }
      }
      continue;
    }

    if (c === "'" || c === '"') {
      const escapes = c === "'" && i > 0 && /[eE]/.test(chars[i - 1]) && !isWord(chars[i - 2]);
      out += c;
      i++;
      while (i < n) {
        if (escapes && chars[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (chars[i] === c) {
          if (chars[i + 1] === c) {
            out += "  ";
            i += 2;
            continue;
          }
          break;
        }
        out += blank(chars[i]);
        i++;
      }
      if (i < n) {
        out += c;
        i++;
      }
      continue;
    }

    if (c === "$" && !isWord(chars[i - 1])) {
      let j = i + 1;
      while (j < n && isWord(chars[j])) j++;
      if (chars[j] === "$") {
        const tag = chars.slice(i, j + 1).join("");
        let k = j + 1;
        let closed = false;
        while (k + tag.length <= n) {
          if (chars.slice(k, k + tag.length).join("") === tag) {
            closed = true;
            break;
          }
          k++;
        }
        const end = closed ? k + tag.length : n;
        for (let p = i; p < end; p++) out += blank(chars[p]);
        i = end;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

export interface Danger {
  label: string;
  statement: string;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

export function findDangers(sql: string): Danger[] {
  const codeChars = Array.from(codeOnly(sql));
  const chars = Array.from(sql);
  const dangers: Danger[] = [];
  let start = 0;

  const inspect = (from: number, to: number) => {
    const piece = codeChars.slice(from, to).join("");
    const tokens = words(piece);
    if (tokens.length === 0) return;
    const first = tokens[0];
    let label: string | null = null;
    if (first === "delete" && !tokens.includes("where")) label = "DELETE sin WHERE: borra todas las filas de la tabla";
    else if (first === "update" && !tokens.includes("where")) label = "UPDATE sin WHERE: modifica todas las filas de la tabla";
    else if (first === "truncate") label = "TRUNCATE: vacía la tabla por completo";
    else if (first === "drop") label = "DROP: elimina objetos de la base de datos";
    else if (first === "alter" && tokens.includes("drop")) label = "ALTER … DROP: elimina columnas o restricciones";
    if (label) {
      const text = chars.slice(from, to).join("").trim().replace(/\s+/g, " ");
      dangers.push({ label, statement: text.length > 120 ? text.slice(0, 117) + "…" : text });
    }
  };

  for (let i = 0; i < codeChars.length; i++) {
    if (codeChars[i] === ";") {
      inspect(start, i);
      start = i + 1;
    }
  }
  inspect(start, codeChars.length);
  return dangers;
}
