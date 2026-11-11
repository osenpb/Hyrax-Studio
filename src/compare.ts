type Cell = string | null;

export interface Comparable {
  columns: string[];
  rows: Cell[][];
}

export type DiffKind = "added" | "removed" | "changed" | "same";

export interface DiffRow {
  kind: DiffKind;
  a: Cell[] | null;
  b: Cell[] | null;
  changed: Set<number>;
}

export interface DiffResult {
  columns: string[];
  rows: DiffRow[];
  counts: Record<DiffKind, number>;
  onlyInA: string[];
  onlyInB: string[];
  duplicateKeys: number;
}

const keyOf = (row: Cell[], indexes: number[]) => JSON.stringify(indexes.map((i) => row[i] ?? null));

/**
 * Compara dos resultados por las columnas que tienen en común. Con `keyColumns` empareja filas por clave
 * (y detecta las modificadas); sin clave compara filas completas, así que solo hay añadidas, eliminadas e iguales.
 */
export function diffResults(a: Comparable, b: Comparable, keyColumns: string[]): DiffResult {
  const common = a.columns.filter((c) => b.columns.includes(c));
  const ai = common.map((c) => a.columns.indexOf(c));
  const bi = common.map((c) => b.columns.indexOf(c));
  const keyPositions = keyColumns.map((c) => common.indexOf(c)).filter((i) => i >= 0);
  const useKey = keyPositions.length > 0;
  const project = (row: Cell[], idx: number[]): Cell[] => idx.map((i) => row[i] ?? null);
  const all = common.map((_, i) => i);

  const bRows = b.rows.map((r) => project(r, bi));
  const bMap = new Map<string, number[]>();
  bRows.forEach((row, index) => {
    const key = keyOf(row, useKey ? keyPositions : all);
    const list = bMap.get(key);
    if (list) list.push(index);
    else bMap.set(key, [index]);
  });

  const rows: DiffRow[] = [];
  const matched = new Set<number>();
  let duplicateKeys = 0;
  const seenA = new Set<string>();

  for (const raw of a.rows) {
    const row = project(raw, ai);
    const key = keyOf(row, useKey ? keyPositions : all);
    if (useKey && seenA.has(key)) duplicateKeys++;
    seenA.add(key);
    const candidates = bMap.get(key)?.filter((i) => !matched.has(i)) ?? [];
    if (candidates.length === 0) {
      rows.push({ kind: "removed", a: row, b: null, changed: new Set() });
      continue;
    }
    const index = candidates[0];
    matched.add(index);
    const other = bRows[index];
    const changed = new Set<number>();
    if (useKey) row.forEach((v, i) => v !== other[i] && changed.add(i));
    rows.push({ kind: changed.size > 0 ? "changed" : "same", a: row, b: other, changed });
  }

  bRows.forEach((row, index) => {
    if (!matched.has(index)) rows.push({ kind: "added", a: null, b: row, changed: new Set() });
  });

  const counts: Record<DiffKind, number> = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const r of rows) counts[r.kind]++;
  if (useKey) {
    const seenB = new Set<string>();
    for (const row of bRows) {
      const key = keyOf(row, keyPositions);
      if (seenB.has(key)) duplicateKeys++;
      seenB.add(key);
    }
  }
  return {
    columns: common,
    rows,
    counts,
    onlyInA: a.columns.filter((c) => !b.columns.includes(c)),
    onlyInB: b.columns.filter((c) => !a.columns.includes(c)),
    duplicateKeys,
  };
}
