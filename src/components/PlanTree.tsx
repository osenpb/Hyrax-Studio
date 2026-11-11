import { useState } from "react";
import { heaviest, type ParsedPlan, type PlanNode } from "../plan";

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function title(node: PlanNode): string {
  let text = node.type;
  if (node.joinType && node.joinType !== "Inner") text += ` (${node.joinType})`;
  if (node.relation) {
    text += ` en ${node.relation}`;
    if (node.alias && node.alias !== node.relation) text += ` ${node.alias}`;
  }
  if (node.index) text += ` con ${node.index}`;
  return text;
}

function Node({ node, depth, analyzed }: { node: PlanNode; depth: number; analyzed: boolean }) {
  const [open, setOpen] = useState(true);
  const level = node.share >= 0.5 ? "hot" : node.share >= 0.2 ? "warm" : "";
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div className={"plan-node " + level} style={{ marginLeft: depth * 18 }}>
        <div className="plan-head">
          <button
            className={"ghost icon-btn plan-toggle" + (hasChildren ? "" : " hidden")}
            onClick={() => setOpen((o) => !o)}
            title={open ? "Contraer" : "Expandir"}
            aria-label={open ? "Contraer nodo" : "Expandir nodo"}
          >
            {open ? "▾" : "▸"}
          </button>
          <strong className="plan-title">{title(node)}</strong>
          <span className="plan-bar" title={`${(node.share * 100).toFixed(1)}% del total`}>
            <span style={{ width: `${Math.max(node.share * 100, node.share > 0 ? 2 : 0)}%` }} />
          </span>
          <span className="plan-pct">{(node.share * 100).toFixed(node.share >= 0.1 ? 0 : 1)}%</span>
        </div>
        <div className="plan-meta">
          <span>costo {fmt(node.startupCost)}..{fmt(node.totalCost)}</span>
          <span>filas est. {fmt(node.planRows)}</span>
          {analyzed && node.actualRows !== null && (
            <span>
              filas reales {fmt(node.actualRows)}
              {node.loops !== null && node.loops > 1 ? ` × ${fmt(node.loops)} vueltas` : ""}
            </span>
          )}
          {analyzed && node.actualTime !== null && <span>{fmt(node.actualTime)} ms</span>}
          {node.misestimate !== null && (
            <span className="plan-warn" title="La estimación de filas del planificador se desvió mucho de la realidad: suele indicar estadísticas desactualizadas (ANALYZE)">
              estimación errada ×{fmt(node.misestimate)}
            </span>
          )}
        </div>
        {node.details.map((line, i) => (
          <div key={i} className="plan-detail">
            {line}
          </div>
        ))}
      </div>
      {open && node.children.map((child, i) => <Node key={i} node={child} depth={depth + 1} analyzed={analyzed} />)}
    </div>
  );
}

export default function PlanTree({ plan, raw }: { plan: ParsedPlan; raw: string }) {
  const [mode, setMode] = useState<"tree" | "json">("tree");
  const worst = heaviest(plan);
  return (
    <div className="plan-tree">
      <div className="plan-summary">
        <div className="segmented small-seg">
          <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>
            Árbol
          </button>
          <button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
        {plan.planningTime !== null && <span className="muted">Planificación {fmt(plan.planningTime)} ms</span>}
        {plan.executionTime !== null && <span className="muted">Ejecución {fmt(plan.executionTime)} ms</span>}
        {!plan.analyzed && <span className="muted">Costos estimados (no se ejecutó la consulta)</span>}
        {worst && worst.share > 0 && (
          <span className="plan-worst">
            Nodo más costoso: <strong>{title(worst)}</strong> ({(worst.share * 100).toFixed(0)}%)
          </span>
        )}
      </div>
      {mode === "tree" ? (
        <div className="plan-nodes">
          <Node node={plan.root} depth={0} analyzed={plan.analyzed} />
        </div>
      ) : (
        <pre className="plan">{JSON.stringify(JSON.parse(raw), null, 2)}</pre>
      )}
    </div>
  );
}
