import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InsertValue, ResultSet, SortKey } from "../api";
import { copyText, toJsonRows, toTsv, tryParseJson } from "../clipboard";
import Icon from "./Icon";
import RowForm from "./RowForm";
import { t } from "../i18n";

export const ROW_HEIGHT = 25;
const OVERSCAN = 15;
export const VIRTUAL_MIN = 150;
const ROWNUM_WIDTH = 64;
const FALLBACK_VIEWPORT = 600;

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
  /** Tipo de cada columna, para mostrar JSON y arreglos de forma adecuada en la vista de fila. */
  columnTypes?: Record<string, string>;
  /** Columnas que forman parte de una clave foránea y permiten ir al registro relacionado. */
  fkColumns?: Set<string>;
  onFollow?: (rowIndex: number, column: string) => void;
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
        aria-label={t("Editar celda")}
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
        title={t("Guardar NULL")}
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
          aria-label={t("Nuevo {name}", { name: props.column })}
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
  columnTypes,
  fkColumns,
  onFollow,
}: Props) {
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [rows, setRows] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [jsonRaw, setJsonRaw] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [formRow, setFormRow] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const empty = result.columns.length === 0;
  const virtual = result.rows.length > VIRTUAL_MIN;

  useEffect(() => {
    setRows(new Set());
    setAnchor(null);
    setSelected(null);
    setEditing(null);
    setFormRow(null);
  }, [result]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewport(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [empty]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [rowOffset]);

  const widths = useMemo(() => {
    if (!virtual) return null;
    return result.columns.map((name, c) => {
      let longest = name.length + 4;
      for (const row of result.rows) {
        const v = row[c];
        const length = v === null ? 4 : Math.min(v.length, 60);
        if (length > longest) longest = length;
      }
      return Math.min(440, Math.max(70, Math.round(longest * 7.4) + 28));
    });
  }, [result, virtual]);

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
    flash((await copyText(text)) ? t("Copiado") : t("No se pudo copiar"));
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
        void copyText(cell ?? "").then((ok) => flash(ok ? t("Copiado") : t("No se pudo copiar")));
      }
    } else if (e.key === "Escape") {
      setRows(new Set());
    }
  };

  if (empty) {
    return (
      <div className="grid-empty">
        {result.affected !== null ? t("Comando ejecutado. Filas afectadas: {n}", { n: result.affected }) : t("Sin resultado")}
      </div>
    );
  }

  const pkSet = new Set(edit?.pkColumns ?? []);
  const total = result.rows.length;
  const first = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtual
    ? Math.min(total, Math.ceil((scrollTop + (viewport || FALLBACK_VIEWPORT)) / ROW_HEIGHT) + OVERSCAN)
    : total;
  const formKey = formRow !== null && edit ? edit.rowKey(result.rows[formRow] ?? []) : "";
  const formDeleted = formRow !== null && (edit?.deletedKeys.has(formKey) ?? false);

  return (
    <div className="grid-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      {rows.size > 0 && (
        <div className="selection-bar">
          <strong>
            {rows.size.toLocaleString()} {rows.size === 1 ? t("fila seleccionada") : t("filas seleccionadas")}
          </strong>
          <button className="small" onClick={() => void copyRows("tsv")} title={t("Copiar como TSV con encabezados (pega bien en Excel)")}>
            <Icon name="copy" size={12} /> {t("Copiar TSV")}
          </button>
          <button className="small" onClick={() => void copyRows("json")}>
            <Icon name="copy" size={12} /> {t("Copiar JSON")}
          </button>
          {selectedList.length === 1 && (
            <button
              className="small"
              onClick={() => setFormRow(selectedList[0])}
              title={t("Ver y editar la fila como formulario: valores largos, JSON y arreglos")}
            >
              <Icon name="form" size={12} /> {t("Ver fila")}
            </button>
          )}
          {selectionActions?.(selectedList)}
          {copied && <span className="muted">{copied}</span>}
          <span className="spacer" />
          <button className="ghost small" onClick={() => setRows(new Set())}>
            {t("Quitar selección")}
          </button>
        </div>
      )}
      <div className="grid-scroll" ref={scroller} onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}>
        <table
          className={"grid" + (virtual ? " virtual" : "")}
          style={
            widths
              ? { tableLayout: "fixed", width: ROWNUM_WIDTH + widths.reduce((a, b) => a + b, 0) }
              : undefined
          }
        >
          {widths && (
            <colgroup>
              <col style={{ width: ROWNUM_WIDTH }} />
              {widths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
          )}
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
                    title={onSort ? t("Clic: ordenar · Mayús+clic: añadir otra columna al orden") : undefined}
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
                    title={t("Quitar fila nueva")}
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
            {virtual && first > 0 && (
              <tr className="spacer-row" aria-hidden="true">
                <td colSpan={result.columns.length + 1} style={{ height: first * ROW_HEIGHT }} />
              </tr>
            )}
            {result.rows.slice(first, last).map((row, offset) => {
              const r = first + offset;
              const key = edit ? edit.rowKey(row) : "";
              const update = edit?.updates[key];
              const deleted = edit?.deletedKeys.has(key) ?? false;
              return (
                <tr
                  key={r}
                  className={(r % 2 === 1 ? "alt " : "") + (rows.has(r) ? "row-selected " : "") + (deleted ? "row-deleted" : "")}
                >
                  <td
                    className="rownum selectable"
                    title={t("Clic: seleccionar fila · Ctrl+clic: añadir · Mayús+clic: rango")}
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
                        {shown !== null && onFollow && fkColumns?.has(name) && (
                          <button
                            className="fk-follow"
                            title={t("Ir al registro relacionado")}
                            aria-label={t("Ir al registro relacionado de {name}", { name })}
                            onClick={(e) => {
                              e.stopPropagation();
                              onFollow(r, name);
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                          >
                            <Icon name="goto" size={11} />
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {virtual && last < total && (
              <tr className="spacer-row" aria-hidden="true">
                <td colSpan={result.columns.length + 1} style={{ height: (total - last) * ROW_HEIGHT }} />
              </tr>
            )}
          </tbody>
        </table>
        {result.rows.length === 0 && !edit?.inserts.length && <div className="grid-empty">{t("Sin filas")}</div>}
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
                  {t("Crudo")}
                </button>
              </div>
            )}
            <span className="spacer" />
            <button
              onClick={() =>
                void copyText(
                  parsedJson !== undefined && !jsonRaw ? JSON.stringify(parsedJson, null, 2) : (cell ?? ""),
                ).then((ok) => flash(ok ? t("Copiado") : t("No se pudo copiar")))
              }
              disabled={cell === null || cell === undefined}
            >
              <Icon name="copy" size={12} /> {copied ?? t("Copiar")}
            </button>
            <button className="ghost icon-btn" onClick={() => setSelected(null)} title={t("Cerrar")}>
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
      {formRow !== null && result.rows[formRow] && (
        <RowForm
          columns={result.columns}
          rows={result.rows}
          index={formRow}
          rowNumber={rowOffset + formRow + 1}
          types={columnTypes}
          pkColumns={edit?.pkColumns ?? []}
          staged={edit?.updates[formKey]?.set ?? {}}
          editable={(edit?.enabled ?? false) && !formDeleted}
          onNavigate={setFormRow}
          onStage={(r, c, v) => edit?.onEditCell(r, c, v)}
          onClose={() => setFormRow(null)}
        />
      )}
    </div>
  );
}
