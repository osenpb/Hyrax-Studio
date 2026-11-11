/** Puntaje de coincidencia por subsecuencia (sin distinguir mayúsculas); null si no coincide. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    score += 1;
    if (at === previous + 1) score += 3;
    if (at === 0 || /[._\s-]/.test(t[at - 1])) score += 2;
    previous = at;
    from = at + 1;
  }
  if (t.startsWith(q)) score += 8;
  else if (t.includes(q)) score += 4;
  return score - t.length * 0.01;
}

export function rank<T>(items: T[], query: string, texts: (item: T) => string[], limit: number): T[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    let best: number | null = null;
    texts(item).forEach((text, i) => {
      const s = fuzzyScore(query, text);
      if (s !== null) best = Math.max(best ?? -Infinity, s + (i === 0 ? 2 : 0));
    });
    if (best !== null) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
