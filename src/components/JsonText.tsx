import type { ReactNode } from "react";

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Colorea un texto JSON ya formateado: claves, cadenas, números, booleanos y null. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
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

// Cadenas (y claves entre comillas), constructores de tipos de mongosh, expresiones regulares, claves sin comillas,
// números y palabras reservadas, en ese orden de prioridad.
const SHELL_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:ObjectId|ISODate|Long|Decimal128|UUID|BinData|Timestamp|MinKey|MaxKey|Code|Symbol)\((?:[^()]|\([^()]*\))*\)|\/(?:\\.|[^/\\\n])+\/[a-z]*|\b([A-Za-z_$][\w$]*)(?=:\s)|\b(?:true|false)\b|\b(?:null|undefined)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\bNaN\b|-?\bInfinity\b/g;

/** Colorea un documento al estilo mongosh: claves sin comillas, ObjectId('…') y demás tipos resaltados. */
export function highlightShell(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  const push = (cls: string, content: string) =>
    out.push(
      <span key={i++} className={cls}>
        {content}
      </span>,
    );
  for (const m of text.matchAll(SHELL_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        push("jt-key", m[1]);
        out.push(m[2]);
      } else push("jt-string", m[1]);
    } else if (m[3] !== undefined) push("jt-key", token);
    else if (/^(?:ObjectId|ISODate|Long|Decimal128|UUID|BinData|Timestamp|MinKey|MaxKey|Code|Symbol)\(/.test(token) || token.startsWith("/"))
      push("jt-type", token);
    else if (token === "true" || token === "false") push("jt-bool", token);
    else if (token === "null" || token === "undefined") push("jt-null", token);
    else push("jt-num", token);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Texto coloreado en un bloque que conserva los espacios. `kind`: JSON o estilo mongosh. */
export default function JsonText({ text, kind = "json" }: { text: string; kind?: "json" | "shell" }) {
  return <pre className="json-text">{kind === "shell" ? highlightShell(text) : highlightJson(text)}</pre>;
}
