import type { ChangeSet, InsertValue } from "./api";
import { t } from "./i18n";

export interface PendingUpdate {
  pk: Record<string, string>;
  original: Record<string, string | null>;
  set: Record<string, string | null>;
}

export interface InsertDraft {
  id: number;
  values: Record<string, InsertValue>;
}

export interface Pending {
  updates: Record<string, PendingUpdate>;
  deletes: Record<string, Record<string, string>>;
  inserts: InsertDraft[];
}

export const emptyPending: Pending = { updates: {}, deletes: {}, inserts: [] };

export function rowKeyOf(pkIndexes: number[], row: (string | null)[]): string {
  return JSON.stringify(pkIndexes.map((i) => row[i]));
}

export function pkOf(pkColumns: string[], pkIndexes: number[], row: (string | null)[]): Record<string, string> {
  const pk: Record<string, string> = {};
  pkColumns.forEach((name, i) => {
    pk[name] = row[pkIndexes[i]] ?? "";
  });
  return pk;
}

export function stageCellEdit(
  pending: Pending,
  key: string,
  pk: Record<string, string>,
  column: string,
  original: string | null,
  next: string | null,
): Pending {
  const current = pending.updates[key];
  const set = { ...(current?.set ?? {}) };
  const originals = { ...(current?.original ?? {}) };
  if (next === original) {
    delete set[column];
    delete originals[column];
  } else {
    set[column] = next;
    originals[column] = original;
  }
  const updates = { ...pending.updates };
  if (Object.keys(set).length === 0) delete updates[key];
  else updates[key] = { pk, original: originals, set };
  return { ...pending, updates };
}

export function stageDelete(
  pending: Pending,
  entries: { key: string; pk: Record<string, string> }[],
): Pending {
  const allDeleted = entries.length > 0 && entries.every((e) => e.key in pending.deletes);
  const deletes = { ...pending.deletes };
  const updates = { ...pending.updates };
  for (const { key, pk } of entries) {
    if (allDeleted) {
      delete deletes[key];
    } else {
      deletes[key] = pk;
      delete updates[key];
    }
  }
  return { ...pending, deletes, updates };
}

export function pendingCount(pending: Pending): number {
  return Object.keys(pending.updates).length + Object.keys(pending.deletes).length + pending.inserts.length;
}

export function toChangeSet(pending: Pending): ChangeSet {
  return {
    updates: Object.values(pending.updates).map((u) => ({ pk: u.pk, original: u.original, set: u.set })),
    deletes: Object.values(pending.deletes).map((pk) => ({ pk })),
    inserts: pending.inserts.map((draft) => ({
      values: Object.fromEntries(Object.entries(draft.values).filter(([, v]) => v.mode !== "default")),
    })),
  };
}

export function summarize(pending: Pending): string {
  const parts: string[] = [];
  const u = Object.keys(pending.updates).length;
  const d = Object.keys(pending.deletes).length;
  const i = pending.inserts.length;
  if (u) parts.push(`${u} ${u === 1 ? t("fila modificada") : t("filas modificadas")}`);
  if (i) parts.push(`${i} ${i === 1 ? t("fila nueva") : t("filas nuevas")}`);
  if (d) parts.push(`${d} ${d === 1 ? t("fila eliminada") : t("filas eliminadas")}`);
  return parts.join(" · ");
}
