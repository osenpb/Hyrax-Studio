import { codeOnly } from "./sqlscan";

export interface Statement {
  /** Desplazamientos UTF-16 sobre el texto original (los mismos que usa CodeMirror). */
  from: number;
  to: number;
  text: string;
}

interface Segment {
  from: number;
  to: number;
  codeFrom: number;
}

function unitOffsets(sql: string): number[] {
  const offsets = [0];
  let units = 0;
  for (const ch of sql) {
    units += ch.length;
    offsets.push(units);
  }
  return offsets;
}

function segments(sql: string): Segment[] {
  const masked = Array.from(codeOnly(sql));
  const offsets = unitOffsets(sql);
  const out: Segment[] = [];
  let start = 0;

  const close = (end: number) => {
    let first = start;
    while (first < end && (/\s/.test(masked[first]) || masked[first] === ";")) first++;
    if (first < end) out.push({ from: offsets[start], to: offsets[end], codeFrom: offsets[first] });
    start = end;
  };

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ";") close(i + 1);
  }
  close(masked.length);
  return out;
}

const trimmed = (sql: string, seg: Segment): Statement => {
  const raw = sql.slice(seg.from, seg.to);
  const lead = raw.length - raw.trimStart().length;
  const tail = raw.length - raw.trimEnd().length;
  return { from: seg.from + lead, to: seg.to - tail, text: raw.trim() };
};

/** Sentencias con contenido, separadas por `;` fuera de cadenas, comentarios y bloques `$$`. */
export function splitStatements(sql: string): Statement[] {
  return segments(sql).map((s) => trimmed(sql, s));
}

/** La sentencia donde está el cursor. Entre dos sentencias gana la anterior, como en DataGrip. */
export function statementAt(sql: string, pos: number): Statement | null {
  const all = segments(sql);
  if (all.length === 0) return null;
  let index = all.findIndex((s) => pos <= s.to);
  if (index === -1) index = all.length - 1;
  if (index > 0 && pos < all[index].codeFrom && /^\s*$/.test(sql.slice(all[index - 1].to, pos))) {
    index -= 1;
  }
  return trimmed(sql, all[index]);
}
