import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  databaseOfSession,
  errorText,
  type ColumnFilter,
  type ColumnInfo,
  type ExportFormat,
  type InsertValue,
  type SortKey,
  type TablePage,
} from "../api";
import { askExportPath } from "../exporting";
import {
  emptyPending,
  pendingCount,
  pkOf,
  rowKeyOf,
  stageCellEdit,
  stageDelete,
  summarize,
  toChangeSet,
  type Pending,
} from "../editing";
import { parseFilters } from "../filters";
import ResultGrid, { type GridEdit } from "./ResultGrid";
import ExportMenu from "./ExportMenu";
import ModeChip from "./ModeChip";
import Icon from "./Icon";

interface Props {
  connId: string;
  schema: string;
  table: string;
  readOnly: boolean;
  production: boolean;
  onSetReadOnly: (readOnly: boolean, confirm?: string) => Promise<void>;
}

const PAGE_SIZES = [50, 100, 200, 500, 1000];

export default function TableTab({ connId, schema, table, readOnly, production, onSetReadOnly }: Props) {
  const [view, setView] = useState<"data" | "structure">("data");
  const [pageSize, setPageSize] = useState(200);
  const [offset, setOffset] = useState(0);
  const [sorts, setSorts] = useState<SortKey[]>([]);
  const [page, setPage] = useState<TablePage | null>(null);
  const [exactCount, setExactCount] = useState<number | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filterInputs, setFilterInputs] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<ColumnFilter[]>([]);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [pending, setPending] = useState<Pending>(emptyPending);
  const [review, setReview] = useState<{ sql: string[]; error: string | null; applying: boolean } | null>(null);
  const lastApplied = useRef("[]");
  const nextInsertId = useRef(0);

  const pkColumns = columns?.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
  const effectiveSorts: SortKey[] =
    sorts.length > 0 ? sorts : pkColumns.map((column) => ({ column, descending: false }));
  const orderKey = JSON.stringify(effectiveSorts);
  const columnsReady = columns !== null;

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = parseFilters(filterInputs);
      const serialized = JSON.stringify(next);
      if (serialized !== lastApplied.current) {
        lastApplied.current = serialized;
        setApplied(next);
        setOffset(0);
        setExactCount(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [filterInputs]);

  useEffect(() => {
    if (!columnsReady) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .tableData(connId, schema, table, pageSize, offset, applied, effectiveSorts)
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connId, schema, table, pageSize, offset, applied, orderKey, columnsReady, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api
      .listColumns(connId, schema, table)
      .then((c) => !cancelled && setColumns(c))
      .catch((e) => {
        if (cancelled) return;
        setError(errorText(e));
        setColumns((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, schema, table, reloadKey]);

  const sort = useCallback((column: string, additive: boolean) => {
    setOffset(0);
    setSorts((prev) => {
      const index = prev.findIndex((s) => s.column === column);
      if (additive) {
        if (index === -1) return [...prev, { column, descending: false }];
        if (!prev[index].descending) return prev.map((s, i) => (i === index ? { ...s, descending: true } : s));
        return prev.filter((_, i) => i !== index);
      }
      if (index !== -1 && prev.length === 1) {
        return prev[0].descending ? [] : [{ column, descending: true }];
      }
      return [{ column, descending: false }];
    });
  }, []);

  const countExact = () => {
    api
      .countRows(connId, schema, table, applied)
      .then(setExactCount)
      .catch((e) => setError(errorText(e)));
  };

  const refresh = () => {
    setExactCount(null);
    setReloadKey((k) => k + 1);
  };

  const cancel = () => {
    api.cancelQuery(connId).catch(() => undefined);
  };

  const exportData = async (format: ExportFormat) => {
    setNotice(null);
    const path = await askExportPath(`${schema}_${table}`, format);
    if (!path) return;
    setExporting(true);
    setError(null);
    try {
      const result = await api.exportTable(connId, schema, table, applied, effectiveSorts, format, path);
      setNotice(`Se exportaron ${result.rows.toLocaleString()} filas a ${path}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  const changeFilter = (column: string, value: string) =>
    setFilterInputs((prev) => ({ ...prev, [column]: value }));

  const pageColumns = page?.result.columns ?? [];
  const rows = page?.result.rows ?? [];
  const pkIndexes = pkColumns.map((name) => pageColumns.indexOf(name));
  const pkReady = pkColumns.length > 0 && pkIndexes.every((i) => i >= 0);
  const editBlock = readOnly
    ? "La sesión está en solo lectura: habilita la escritura para editar"
    : !columns
      ? "Cargando la estructura de la tabla…"
      : pkColumns.length === 0
        ? "La tabla no tiene clave primaria: no se puede editar de forma segura"
        : null;
  const canEdit = editBlock === null && pkReady;
  const editing = editMode && canEdit;
  const count = pendingCount(pending);

  const editCell = (rowIndex: number, colIndex: number, value: string | null) => {
    const row = rows[rowIndex];
    const key = rowKeyOf(pkIndexes, row);
    const pk = pkOf(pkColumns, pkIndexes, row);
    setPending((p) => stageCellEdit(p, key, pk, pageColumns[colIndex], row[colIndex], value));
  };

  const markDeleted = (rowIndexes: number[]) => {
    const entries = rowIndexes.map((i) => ({
      key: rowKeyOf(pkIndexes, rows[i]),
      pk: pkOf(pkColumns, pkIndexes, rows[i]),
    }));
    setPending((p) => stageDelete(p, entries));
  };

  const addInsert = () => {
    nextInsertId.current += 1;
    const id = nextInsertId.current;
    setPending((p) => ({ ...p, inserts: [{ id, values: {} }, ...p.inserts] }));
  };

  const editInsert = (id: number, column: string, cell: InsertValue) =>
    setPending((p) => ({
      ...p,
      inserts: p.inserts.map((d) => (d.id === id ? { ...d, values: { ...d.values, [column]: cell } } : d)),
    }));

  const removeInsert = (id: number) =>
    setPending((p) => ({ ...p, inserts: p.inserts.filter((d) => d.id !== id) }));

  const openReview = async () => {
    setReview({ sql: [], error: null, applying: false });
    try {
      const sql = await api.previewChanges(connId, schema, table, toChangeSet(pending));
      setReview({ sql, error: null, applying: false });
    } catch (e) {
      setReview({ sql: [], error: errorText(e), applying: false });
    }
  };

  const applyPending = async () => {
    setReview((r) => (r ? { ...r, applying: true, error: null } : r));
    try {
      const result = await api.applyChanges(connId, schema, table, toChangeSet(pending));
      setPending(emptyPending);
      setReview(null);
      setNotice(
        `Cambios aplicados en una transacción: ${result.updated} modificadas, ${result.inserted} nuevas, ${result.deleted} eliminadas.`,
      );
      refresh();
    } catch (e) {
      setReview((r) => (r ? { ...r, applying: false, error: errorText(e) } : r));
    }
  };

  const gridEdit: GridEdit = {
    enabled: editing,
    pkColumns,
    rowKey: (row) => rowKeyOf(pkIndexes, row),
    updates: pending.updates,
    deletedKeys: new Set(Object.keys(pending.deletes)),
    onEditCell: editCell,
    inserts: pending.inserts,
    onEditInsert: editInsert,
    onRemoveInsert: removeInsert,
  };

  const typedFilters = Object.values(filterInputs).filter((v) => v.trim() !== "").length;
  const rowsShown = rows.length;
  const hasNext = rowsShown === pageSize;
  const total =
    exactCount !== null
      ? `${exactCount.toLocaleString()} filas`
      : applied.length > 0
        ? "con filtros · usa Contar exacto"
        : page?.estimatedRows != null
          ? `~${page.estimatedRows.toLocaleString()} filas (estimado)`
          : "total desconocido";
  const soft = error !== null && /^(Consulta cancelada|Tiempo de espera)/.test(error);

  return (
    <div className={"tab-body" + (production ? " is-prod" : "")}>
      <div className="toolbar wrap">
        <div className="segmented">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>
            Datos
          </button>
          <button className={view === "structure" ? "active" : ""} onClick={() => setView("structure")}>
            Estructura
          </button>
        </div>
        <span className="chip chip-plain">
          <Icon name="table" size={13} /> {schema}.{table}
        </span>
        <ModeChip
          readOnly={readOnly}
          production={production}
          database={databaseOfSession(connId)}
          onSet={onSetReadOnly}
          onError={setError}
        />
        <span className="spacer" />
        {typedFilters > 0 && (
          <button onClick={() => setFilterInputs({})} title="Quitar todos los filtros">
            <Icon name="close" size={12} /> Limpiar filtros ({typedFilters})
          </button>
        )}
        {editing && (
          <button onClick={addInsert} title="Añadir una fila nueva (no se guarda hasta aplicar los cambios)">
            <Icon name="plus" size={13} /> Nueva fila
          </button>
        )}
        <button
          className={editMode && canEdit ? "toggled" : ""}
          onClick={() => setEditMode((m) => !m)}
          disabled={(!canEdit && !editMode) || view !== "data"}
          title={editBlock ?? "Doble clic en una celda para editarla; los cambios esperan hasta que los apliques"}
        >
          <Icon name="edit" size={13} /> {editing ? "Editando" : "Editar datos"}
        </button>
        <ExportMenu onExport={exportData} disabled={exporting || view !== "data"} />
        <button onClick={refresh} disabled={loading}>
          <Icon name="refresh" size={13} /> Refrescar
        </button>
      </div>

      {error && (
        <div className={"alert " + (soft ? "alert-warn" : "alert-error")}>
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="alert alert-ok">
          <Icon name="download" size={15} />
          <span>{notice}</span>
          <button className="ghost icon-btn" onClick={() => setNotice(null)} title="Cerrar">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {count > 0 && (
        <div className="pending-bar">
          <Icon name="edit" size={14} />
          <strong>{count === 1 ? "1 cambio pendiente" : `${count} cambios pendientes`}</strong>
          <span className="muted">{summarize(pending)} · todavía no se guardó nada en la base</span>
          <span className="spacer" />
          <button onClick={() => setPending(emptyPending)}>Descartar</button>
          <button className="primary" onClick={() => void openReview()}>
            Revisar y aplicar…
          </button>
        </div>
      )}

      {view === "data" && (
        <>
          <div className="grid-host">
            {page && (
              <ResultGrid
                result={page.result}
                rowOffset={offset}
                sorts={sorts}
                onSort={sort}
                filters={filterInputs}
                onFilterChange={changeFilter}
                edit={gridEdit}
                selectionActions={(selectedRows) =>
                  editing ? (
                    <button className="small danger" onClick={() => markDeleted(selectedRows)}>
                      <Icon name="trash" size={12} /> Marcar para eliminar
                    </button>
                  ) : null
                }
              />
            )}
            {loading && (
              <div className="loading">
                Cargando…
                <button className="danger small" onClick={cancel}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
          <div className="statusbar">
            <button
              className="icon-btn"
              title="Página anterior"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              <Icon name="prev" size={14} />
            </button>
            <button
              className="icon-btn"
              title="Página siguiente"
              disabled={!hasNext || loading}
              onClick={() => setOffset(offset + pageSize)}
            >
              <Icon name="next" size={14} />
            </button>
            <select
              value={pageSize}
              onChange={(e) => {
                setOffset(0);
                setPageSize(Number(e.target.value));
              }}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} por página
                </option>
              ))}
            </select>
            <span className="muted">
              {rowsShown > 0 ? `${(offset + 1).toLocaleString()}–${(offset + rowsShown).toLocaleString()}` : "0"} · {total}
            </span>
            <button onClick={countExact}>Contar exacto</button>
            <span className="spacer" />
            {exporting && (
              <span className="status-running">
                Exportando…{" "}
                <button className="danger small" onClick={cancel}>
                  Cancelar
                </button>
              </span>
            )}
            {editing && !exporting && <span className="muted">Doble clic en una celda para editar</span>}
            {page && !exporting && !editing && <span className="muted">{page.elapsedMs} ms</span>}
          </div>
        </>
      )}

      {view === "structure" && (
        <div className="grid-host">
          <div className="grid-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th className="rownum">#</th>
                  <th>Columna</th>
                  <th>Tipo</th>
                  <th>Nulo</th>
                  <th>Por defecto</th>
                  <th>PK</th>
                </tr>
              </thead>
              <tbody>
                {(columns ?? []).map((c, i) => (
                  <tr key={c.name}>
                    <td className="rownum">{i + 1}</td>
                    <td>{c.name}</td>
                    <td>{c.dataType}</td>
                    <td>{c.nullable ? "sí" : "no"}</td>
                    <td className={c.default === null ? "null" : ""}>{c.default ?? "—"}</td>
                    <td>{c.isPrimaryKey ? <Icon name="key" className="ic-pk" /> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {review && (
        <div className="modal-backdrop" onMouseDown={() => !review.applying && setReview(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Revisar y aplicar cambios</h2>
            <p>
              {summarize(pending)} en <strong>{schema}.{table}</strong>. Todo se ejecuta en una sola transacción: si
              un cambio falla o la fila cambió mientras tanto, no se aplica ninguno.
            </p>
            {review.sql.length === 0 && !review.error && <p className="muted">Preparando…</p>}
            {review.sql.length > 0 && <pre className="sql-preview">{review.sql.join("\n")}</pre>}
            {review.error && (
              <div className="alert alert-error">
                <Icon name="alert" size={15} />
                <span>{review.error}</span>
              </div>
            )}
            {readOnly && (
              <div className="alert alert-warn">
                <Icon name="lock" size={15} />
                <span>La sesión está en solo lectura: habilita la escritura para aplicar.</span>
              </div>
            )}
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setReview(null)} disabled={review.applying}>
                Cerrar
              </button>
              <button
                className="danger"
                disabled={review.applying || readOnly || review.sql.length === 0}
                onClick={() => void applyPending()}
              >
                {review.applying ? "Aplicando…" : "Aplicar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
