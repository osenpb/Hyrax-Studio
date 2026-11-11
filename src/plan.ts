export interface PlanNode {
  type: string;
  relation: string | null;
  alias: string | null;
  index: string | null;
  joinType: string | null;
  startupCost: number;
  totalCost: number;
  planRows: number;
  actualRows: number | null;
  actualTime: number | null;
  loops: number | null;
  details: string[];
  children: PlanNode[];
  /** Coste (o tiempo, si hubo ANALYZE) propio del nodo, sin contar a los hijos. */
  exclusive: number;
  /** Parte del total del plan que consume este nodo, de 0 a 1. */
  share: number;
  /** Veces que la estimación de filas se desvió de la realidad (solo con ANALYZE). */
  misestimate: number | null;
}

export interface ParsedPlan {
  root: PlanNode;
  analyzed: boolean;
  planningTime: number | null;
  executionTime: number | null;
}

type Raw = Record<string, unknown>;

const DETAIL_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Join Filter",
  "Hash Cond",
  "Merge Cond",
  "Sort Key",
  "Group Key",
  "One-Time Filter",
];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function build(raw: Raw): PlanNode {
  const plans = Array.isArray(raw["Plans"]) ? (raw["Plans"] as Raw[]) : [];
  const details: string[] = [];
  for (const key of DETAIL_KEYS) {
    const value = raw[key];
    if (typeof value === "string") details.push(`${key}: ${value}`);
    else if (Array.isArray(value)) details.push(`${key}: ${value.join(", ")}`);
  }
  const removed = num(raw["Rows Removed by Filter"]);
  if (removed !== null) details.push(`Filas descartadas por el filtro: ${removed.toLocaleString()}`);
  const hit = num(raw["Shared Hit Blocks"]);
  const read = num(raw["Shared Read Blocks"]);
  if (hit !== null || read !== null) details.push(`Bloques: ${hit ?? 0} en caché, ${read ?? 0} leídos de disco`);

  return {
    type: str(raw["Node Type"]) ?? "Nodo",
    relation: str(raw["Relation Name"]),
    alias: str(raw["Alias"]),
    index: str(raw["Index Name"]),
    joinType: str(raw["Join Type"]),
    startupCost: num(raw["Startup Cost"]) ?? 0,
    totalCost: num(raw["Total Cost"]) ?? 0,
    planRows: num(raw["Plan Rows"]) ?? 0,
    actualRows: num(raw["Actual Rows"]),
    actualTime: num(raw["Actual Total Time"]),
    loops: num(raw["Actual Loops"]),
    details,
    children: plans.map(build),
    exclusive: 0,
    share: 0,
    misestimate: null,
  };
}

const total = (n: PlanNode, analyzed: boolean) =>
  analyzed ? (n.actualTime ?? 0) * (n.loops ?? 1) : n.totalCost;

function annotate(node: PlanNode, analyzed: boolean, rootTotal: number) {
  for (const child of node.children) annotate(child, analyzed, rootTotal);
  const children = node.children.reduce((sum, c) => sum + total(c, analyzed), 0);
  node.exclusive = Math.max(0, total(node, analyzed) - children);
  node.share = rootTotal > 0 ? Math.min(1, node.exclusive / rootTotal) : 0;
  if (node.actualRows !== null) {
    const expected = Math.max(node.planRows, 1);
    const actual = Math.max(node.actualRows, 1);
    const ratio = Math.max(expected / actual, actual / expected);
    node.misestimate = ratio >= 10 ? ratio : null;
  }
}

/** Interpreta la salida de `EXPLAIN (FORMAT JSON)`. Devuelve null si el texto no es un plan JSON. */
export function parsePlan(text: string): ParsedPlan | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const first = Array.isArray(data) ? data[0] : data;
  if (typeof first !== "object" || first === null) return null;
  const top = first as Raw;
  const rawRoot = top["Plan"];
  if (typeof rawRoot !== "object" || rawRoot === null) return null;
  const root = build(rawRoot as Raw);
  const analyzed = root.actualTime !== null;
  annotate(root, analyzed, total(root, analyzed));
  return {
    root,
    analyzed,
    planningTime: num(top["Planning Time"]),
    executionTime: num(top["Execution Time"]),
  };
}

export function flatten(node: PlanNode): PlanNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

export function heaviest(plan: ParsedPlan): PlanNode | null {
  const nodes = flatten(plan.root);
  return nodes.reduce<PlanNode | null>((best, n) => (best === null || n.exclusive > best.exclusive ? n : best), null);
}
