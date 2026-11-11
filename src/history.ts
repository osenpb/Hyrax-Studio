export interface HistoryItem {
  sql: string;
  at: number;
  ms: number | null;
  ok: boolean;
}

const MAX_ITEMS = 100;

const ENABLED_KEY = "hyrax-history-enabled";

export function historyEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setHistoryEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off");
  } catch {
    return;
  }
}

const storageKey = (profileId: string) => `hyrax-history:${profileId}`;

export function loadHistory(profileId: string): HistoryItem[] {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

export function addHistory(profileId: string, item: HistoryItem): HistoryItem[] {
  const next = [item, ...loadHistory(profileId).filter((h) => h.sql !== item.sql)].slice(0, MAX_ITEMS);
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

export function clearHistory(profileId: string): void {
  try {
    localStorage.removeItem(storageKey(profileId));
  } catch {
    return;
  }
}

/** Borra el historial de consultas de todas las conexiones (no toca la preferencia de activarlo). */
export function clearAllHistory(): void {
  try {
    const prefix = "hyrax-history:";
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    return;
  }
}
