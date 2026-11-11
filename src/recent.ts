const KEY = "hyrax-recent";
const MAX = 8;

export function recentIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Anota que se usó una conexión (la más reciente primero). Es una comodidad por equipo, no un dato crítico. */
export function markRecent(id: string): void {
  try {
    const next = [id, ...recentIds().filter((x) => x !== id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return;
  }
}

/** Ordena poniendo primero las usadas recientemente (en ese orden) y luego el resto como estaban. */
export function sortByRecent<T extends { id: string }>(items: T[], recent: string[]): T[] {
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id));
}
