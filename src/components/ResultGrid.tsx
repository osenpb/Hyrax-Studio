import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InsertValue, ResultSet, SortKey } from "../api";
import { copyText, toJsonRows, toTsv, tryParseJson } from "../clipboard";
import Icon from "./Icon";

export interface GridEdit {
  enabled: boolean;
  pkColumns: string[];
  rowKey: (row: (string | null)[]) => string;
  updates: Record<string, { set: Record<string, string | null> }>;
  deletedKeys: Set<string>;
  onEditCell: (rowIndex: number, colIndex: number, value: string | null) => void;
  inserts: { id: number; values: Record<string, InsertValue> }[];
  onEditInsert: (id: number, column: string, cell: InsertValue) => void;
  onRemoveInsert: (id: number) => void;
}

interface Props {
  result: ResultSet;
  rowOffset?: number;
  sorts?: SortKey[];
  onSort?: (column: string, additive: boolean) => void;
  filters?: Record<string, string>;
  onFilterChange?: (column: string, value: string) => void;
  selectionActions?: (rows: number[]) => ReactNode;
  edit?: GridEdit;
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function cellClass(value: string | null, selected: boolean, dirty: boolean): string {
  const classes: string[] = [];
  if (value === null) classes.push("null");
  else if (NUMERIC.test(value)) classes.push("num");
  else if (value === "t" || value === "f" || value === "true" || value === "false") classes.push("bool");
  if (selected) classes.push("selected");
  if (dirty) classes.push("dirty");
  return classes.join(" ");
}

function CellEditor(props: {
  initial: string | null;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const done = useRef(false);

  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onCommit(props.initial === null && value === "" ? null : value);
  };

  return (
    <div className="cell-editor">
      <input
        autoFocus
        aria-label="Editar celda"
        value={text}
        placeholder={props.initial === null ? "NULL" : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(text);
          else if (e.key === "Escape") {
            done.current = true;
            props.onCancel();
          }
        }}
        onBlur={() => finish(text)}
      />
      <button
        className="small"
        title="Guardar NULL"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => finish(null)}
      >
        NULL
      </button>
    </div>
  );
}

function InsertCell(props: { value: InsertValue | undefined; column: string; onChange: (cell: InsertValue) => void }) {
  const v = props.value ?? { mode: "default" as const };
  return (
    <td className={"insert-cell" + (v.mode === "null" ? " null" : "")}>
      <div className="cell-editor">
        <input
          aria-label={`Nuevo ${props.column}`}
          value={v.mode === "value" ? v.value : ""}
          disabled={v.mode === "null"}
          placeholder={v.mode === "null" ? "NULL" : "DEFAULT"}
          onChange={(e) =>
            props.onChange(e.target.value === "" ? { mode: "default" } : { mode: "value", value: e.target.value })
          }
        />
        <button
          className="small ghost"
          title={v.mode === "null" ? "Quitar NULL (usar DEFAULT)" : "Poner NULL"}
          onClick={() => props.onChange(v.mode === "null" ? { mode: "default" } : { mode: "null" })}
        >
          ∅
        </button>
      </div>
    </td>
  );
}

export default function ResultGrid({
  result,
  rowOffset = 0,
  sorts,
  onSort,
  filters,
  onFilterChange,
  selectionActions,
  edit,
}: Props) {
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [rows, setRows] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [jsonRaw, setJsonRaw] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setRows(new Set());
    setAnchor(null);
    setSelected(null);
    setEditing(null);
  }, [result]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const cell = selected ? result.rows[selected.row]?.[selected.col] : undefined;
  const column = selected ? result.columns[selected.col] : undefined;
  const parsedJson = tryParseJson(cell ?? null);
  const selectedList = [...rows].sort((a, b) => a - b);

  const flash = (label: string) => {
    setCopied(label);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  };

  const copyRows = async (format: "tsv" | "json") => {
    const picked = selectedList.map((i) => result.rows[i]);
    const text = format === "tsv" ? toTsv(result.columns, picked) : toJsonRows(result.columns, picked);
    flash((await copyText(text)) ? "Copiado" : "No se pudo copiar");
  };

  const selectRow = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      const next = new Set<number>();
      for (let i = from; i <= to; i++) next.add(i);
      setRows(next);
      return;
    }
    setAnchor(index);
    if (e.ctrlKey || e.metaKey) {
      setRows((prev) => {
        const next = new Set(prev);
        if (!next.delete(index)) next.add(index);
        return next;
      });
    } else {
      setRows((prev) => (prev.size === 1 && prev.has(index) ? new Set() : new Set([index])));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setRows(new Set(result.rows.map((_, i) => i)));
    } else if (mod && e.key.toLowerCase() === "c") {
      if (rows.size > 0) {
        e.preventDefault();
        void copyRows("tsv");
      } else if (cell !== undefined && window.getSelection()?.toString() === "") {
        e.preventDefault();
        void copyText(cell ?? "").then((ok) => flash(ok ? "Copiado" : "No se pudo copiar"));
      }
    } else if (e.key === "Escape") {
      setRows(new Set());
    }
  };

  if (result.columns.length === 0) {
    return (
      <div className="grid-empty">
        {result.affected !== null ? `Comando ejecutado. Filas afectadas: ${result.affected}` : "Sin resultado"}
      </div>
    );
  }

  const pkSet = new Set(edit?.pkColumns ?? []);

  return (
    <div className="grid-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      {rows.size > 0 && (
        <div className="selection-bar">
          <strong>
            {rows.size.toLocaleString()} {rows.size === 1 ? "fila seleccionada" : "filas seleccionadas"}
          </strong>
          <button className="small" onClick={() => void copyRows("tsv")} title="Copiar como TSV con encabezados (pega bien en Excel)">
            <Icon name="copy" size={12} /> Copiar TSV
          </button>
          <button className="small" onClick={() => void copyRows("json")}>
            <Icon name="copy" size={12} /> Copiar JSON
          </button>
          {selectionActions?.(selectedList)}
          {copied && <span className="muted">{copied}</span>}
          <span className="spacer" />
          <button className="ghost small" onClick={() => setRows(new Set())}>
            Quitar selección
          </button>
        </div>
      )}
      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {result.columns.map((name, i) => {
                const position = sorts?.findIndex((s) => s.column === name) ?? -1;
                const key = position >= 0 ? sorts![position] : null;
                return (
                  <th
                    key={i}
                    className={onSort ? "sortable" : undefined}
                    title={onSort ? "Clic: ordenar · Mayús+clic: añadir otra columna al orden" : undefined}
                    onClick={onSort ? (e) => onSort(name, e.shiftKey) : undefined}
                  >
                    {name}
                    {pkSet.has(name) && <Icon name="key" size={11} className="ic-pk pk-mark" />}
                    {key && (
                      <span className="sort">
                        {key.descending ? " ▼" : " ▲"}
                        {sorts!.length > 1 && <sup>{position + 1}</sup>}
                      </span>
                    )}
                  </th>
                );
              })}
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
            {edit?.inserts.map((draft) => (
              <tr key={`insert-${draft.id}`} className="row-insert">
                <td className="rownum">
                  <button
                    className="ghost icon-btn"
                    title="Quitar fila nueva"
                    onClick={() => edit.onRemoveInsert(draft.id)}
                    disabled={!edit.enabled}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </td>
                {result.columns.map((name) => (
                  <InsertCell
                    key={name}
                    column={name}
                    value={draft.values[name]}
                    onChange={(cellValue) => edit.onEditInsert(draft.id, name, cellValue)}
                  />
                ))}
              </tr>
            ))}
            {result.rows.map((row, r) => {
              const key = edit ? edit.rowKey(row) : "";
              const update = edit?.updates[key];
              const deleted = edit?.deletedKeys.has(key) ?? false;
              return (
                <tr
                  key={r}
                  className={(rows.has(r) ? "row-selected " : "") + (deleted ? "row-deleted" : "")}
                >
                  <td
                    className="rownum selectable"
                    title="Clic: seleccionar fila · Ctrl+clic: añadir · Mayús+clic: rango"
                    onClick={(e) => selectRow(r, e)}
                  >
                    {(rowOffset + r + 1).toLocaleString()}
                  </td>
                  {row.map((value, c) => {
                    const name = result.columns[c];
                    const dirty = update !== undefined && name in update.set;
                    const shown = dirty ? update.set[name] : value;
                    if (editing?.row === r && editing.col === c) {
                      return (
                        <td key={c} className="editing">
                          <CellEditor
                            initial={shown}
                            onCancel={() => setEditing(null)}
                            onCommit={(next) => {
                              setEditing(null);
                              edit?.onEditCell(r, c, next);
                            }}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={c}
                        className={cellClass(shown, selected?.row === r && selected.col === c, dirty)}
                        onClick={() => setSelected({ row: r, col: c })}
                        onDoubleClick={() => {
                          if (edit?.enabled && !deleted && !pkSet.has(name)) setEditing({ row: r, col: c });
                        }}
                      >
                        {shown === null ? "NULL" : shown}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {result.rows.length === 0 && !edit?.inserts.length && <div className="grid-empty">Sin filas</div>}
      </div>
      {selected && (
        <div className="inspector">
          <div className="inspector-head">
            <strong>{column}</strong>
            {parsedJson !== undefined && (
              <div className="segmented small-seg">
                <button className={!jsonRaw ? "active" : ""} onClick={() => setJsonRaw(false)}>
                  JSON
                </button>
                <button className={jsonRaw ? "active" : ""} onClick={() => setJsonRaw(true)}>
                  Crudo
                </button>
              </div>
            )}
            <span className="spacer" />
            <button
              onClick={() =>
                void copyText(
                  parsedJson !== undefined && !jsonRaw ? JSON.stringify(parsedJson, null, 2) : (cell ?? ""),
                ).then((ok) => flash(ok ? "Copiado" : "No se pudo copiar"))
              }
              disabled={cell === null || cell === undefined}
            >
              <Icon name="copy" size={12} /> {copied ?? "Copiar"}
            </button>
            <button className="ghost icon-btn" onClick={() => setSelected(null)} title="Cerrar">
              <Icon name="close" size={13} />
            </button>
          </div>
          <pre>
            {cell === null
              ? "NULL"
              : parsedJson !== undefined && !jsonRaw
                ? JSON.stringify(parsedJson, null, 2)
                : cell}
          </pre>
        </div>
      )}
    </div>
  );
}
