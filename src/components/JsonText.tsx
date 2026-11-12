import type { ReactNode } from "react";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Colorea un texto JSON ya formateado: claves, cadenas, números, booleanos y null. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        out.push(
          <span key={i++} className="jt-key">
            {m[1]}
          </span>,
          m[2],
        );
      } else {
        out.push(
          <span key={i++} className="jt-string">
            {m[1]}
          </span>,
        );
      }
    } else if (token === "true" || token === "false") {
      out.push(
        <span key={i++} className="jt-bool">
          {token}
        </span>,
      );
    } else if (token === "null") {
      out.push(
        <span key={i++} className="jt-null">
          {token}
        </span>,
      );
    } else {
      out.push(
        <span key={i++} className="jt-num">
          {token}
        </span>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Texto JSON coloreado en un bloque que conserva los espacios. */
export default function JsonText({ text }: { text: string }) {
  return <pre className="json-text">{highlightJson(text)}</pre>;
}
