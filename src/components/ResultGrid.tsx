import { useState } from "react";
import type { ResultSet } from "../api";
import Icon from "./Icon";

interface Props {
  result: ResultSet;
  rowOffset?: number;
  orderBy?: string | null;
  descending?: boolean;
  onSort?: (column: string) => void;
  filters?: Record<string, string>;
  onFilterChange?: (column: string, value: string) => void;
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function cellClass(value: string | null, selected: boolean): string {
  const classes: string[] = [];
  if (value === null) classes.push("null");
  else if (NUMERIC.test(value)) classes.push("num");
  else if (value === "t" || value === "f" || value === "true" || value === "false") classes.push("bool");
  if (selected) classes.push("selected");
  return classes.join(" ");
}

export default function ResultGrid({
  result,
  rowOffset = 0,
  orderBy,
  descending,
  onSort,
  filters,
  onFilterChange,
}: Props) {
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);

  const cell = selected ? result.rows[selected.row]?.[selected.col] : undefined;
  const column = selected ? result.columns[selected.col] : undefined;

  if (result.columns.length === 0) {
    return (
      <div className="grid-empty">
        {result.affected !== null ? `Comando ejecutado. Filas afectadas: ${result.affected}` : "Sin resultado"}
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {result.columns.map((name, i) => (
                <th
                  key={i}
                  className={onSort ? "sortable" : undefined}
                  onClick={onSort ? () => onSort(name) : undefined}
                >
                  {name}
                  {orderBy === name && <span className="sort">{descending ? " ▼" : " ▲"}</span>}
                </th>
              ))}
            </tr>
            {onFilterChange && (
              <tr className="filter-row">
                <th className="rownum">
                  <Icon name="filter" size={11} />
                </th>
                {result.columns.map((name, i) => (
                  <th key={i}>
                    <input
                      className="filter-input"
                      aria-label={`Filtrar ${name}`}
                      placeholder="filtrar…"
                      value={filters?.[name] ?? ""}
                      onChange={(e) => onFilterChange(name, e.target.value)}
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r}>
                <td className="rownum">{(rowOffset + r + 1).toLocaleString()}</td>
                {row.map((value, c) => (
                  <td
                    key={c}
                    className={cellClass(value, selected?.row === r && selected.col === c)}
                    onClick={() => setSelected({ row: r, col: c })}
                  >
                    {value === null ? "NULL" : value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && <div className="grid-empty">Sin filas</div>}
      </div>
      {selected && (
        <div className="inspector">
          <div className="inspector-head">
            <strong>{column}</strong>
            <span className="spacer" />
            <button
              onClick={() => navigator.clipboard.writeText(cell ?? "").catch(() => undefined)}
              disabled={cell === null || cell === undefined}
            >
              <Icon name="copy" size={12} /> Copiar
            </button>
            <button className="ghost icon-btn" onClick={() => setSelected(null)} title="Cerrar">
              <Icon name="close" size={13} />
            </button>
          </div>
          <pre>{cell === null ? "NULL" : cell}</pre>
        </div>
      )}
    </div>
  );
}
