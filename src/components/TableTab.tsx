import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  databaseOfSession,
  errorText,
  type ColumnFilter,
  type ColumnInfo,
  type ExportFormat,
  type ForeignKey,
  type InsertValue,
  type ResultSet,
  type SortKey,
  type TablePage,
  type TableStructure,
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
import StructureView from "./StructureView";
import DdlView from "./DdlView";
import ImportDialog from "./ImportDialog";
import Icon from "./Icon";
import { t } from "../i18n";

interface Props {
  connId: string;
  schema: string;
  table: string;
  readOnly: boolean;
  production: boolean;
  initialFilters?: ColumnFilter[];
  onSetReadOnly: (readOnly: boolean, confirm?: string) => Promise<void>;
  onOpenTable: (schema: string, table: string, filters?: ColumnFilter[]) => void;
  onOpenInSql: (sql: string) => void;
  onPin: (label: string, result: ResultSet) => void;
}

const PAGE_SIZES = [50, 100, 200, 500, 1000, 2000, 5000];

const equalsInput = (filters: ColumnFilter[]): Record<string, string> =>
  Object.fromEntries(filters.map((f) => [f.column, `=${f.value ?? ""}`]));

export default function TableTab({
  connId,
  schema,
  table,
  readOnly,
  production,
  initialFilters,
  onSetReadOnly,
  onOpenTable,
  onOpenInSql,
  onPin,
}: Props) {
  const seed = useRef<Record<string, string> | null>(null);
  if (seed.current === null) seed.current = equalsInput(initialFilters ?? []);
  const [view, setView] = useState<"data" | "structure" | "ddl">("data");
  const [pageSize, setPageSize] = useState(200);
  const [offset, setOffset] = useState(0);
  const [sorts, setSorts] = useState<SortKey[]>([]);
  const [page, setPage] = useState<TablePage | null>(null);
  const [exactCount, setExactCount] = useState<number | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filterInputs, setFilterInputs] = useState<Record<string, string>>(seed.current);
  const [applied, setApplied] = useState<ColumnFilter[]>(initialFilters ?? []);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<Pending>(emptyPending);
  const [review, setReview] = useState<{ sql: string[]; error: string | null; applying: boolean } | null>(null);
  const lastApplied = useRef(JSON.stringify(parseFilters(seed.current)));
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

  useEffect(() => {
    let cancelled = false;
    api
      .tableStructure(connId, schema, table)
      .then((s) => {
        if (cancelled) return;
        setStructure(s);
        setStructureError(null);
      })
      .catch((e) => !cancelled && setStructureError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [connId, schema, table, reloadKey]);

  const fkByColumn = useMemo(() => {
    const map = new Map<string, ForeignKey>();
    for (const fk of structure?.foreignKeys ?? []) for (const c of fk.columns) if (!map.has(c)) map.set(c, fk);
    return map;
  }, [structure]);
  const fkColumns = useMemo(() => new Set(fkByColumn.keys()), [fkByColumn]);
  const columnTypes = useMemo(
    () => Object.fromEntries((columns ?? []).map((c) => [c.name, c.dataType])),
    [columns],
  );

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
      setNotice(t("Se exportaron {n} filas a {path}", { n: result.rows.toLocaleString(), path }));
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
    ? t("La sesión está en solo lectura: habilita la escritura para editar")
    : !columns
      ? t("Cargando la estructura de la tabla…")
      : pkColumns.length === 0
        ? t("La tabla no tiene clave primaria: no se puede editar de forma segura")
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
        t("Cambios aplicados en una transacción: {updated} modificadas, {inserted} nuevas, {deleted} eliminadas.", { updated: result.updated, inserted: result.inserted, deleted: result.deleted }),
      );
      refresh();
    } catch (e) {
      setReview((r) => (r ? { ...r, applying: false, error: errorText(e) } : r));
    }
  };

  const valuesOf = (rowIndex: number, names: string[]): string[] | null => {
    const row = rows[rowIndex];
    if (!row) return null;
    const values = names.map((n) => row[pageColumns.indexOf(n)]);
    return values.every((v): v is string => typeof v === "string") ? values : null;
  };

  const equalsOn = (names: string[], values: string[]): ColumnFilter[] =>
    names.map((column, i) => ({ column, op: "equals", value: values[i] }));

  const followForeignKey = (rowIndex: number, column: string) => {
    const fk = fkByColumn.get(column);
    if (!fk) return;
    const values = valuesOf(rowIndex, fk.columns);
    if (!values) {
      setNotice(t("Esa clave foránea tiene un valor NULL: no apunta a ningún registro."));
      return;
    }
    onOpenTable(fk.refSchema, fk.refTable, equalsOn(fk.refColumns, values));
  };

  const followReferences = (fk: ForeignKey, rowIndex: number) => {
    const values = valuesOf(rowIndex, fk.refColumns);
    if (!values) return;
    onOpenTable(fk.schema, fk.table, equalsOn(fk.columns, values));
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
      ? t("{n} filas", { n: exactCount.toLocaleString() })
      : applied.length > 0
        ? t("con filtros · usa Contar exacto")
        : page?.estimatedRows != null
          ? t("~{n} filas (estimado)", { n: page.estimatedRows.toLocaleString() })
          : t("total desconocido");
  const soft = error !== null && /^(Consulta cancelada|Tiempo de espera|Query cancelled|Timeout)/.test(error);

  return (
    <div className={"tab-body" + (production ? " is-prod" : "")}>
      <div className="toolbar wrap">
        <div className="segmented">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>
            {t("Datos")}
          </button>
          <button className={view === "structure" ? "active" : ""} onClick={() => setView("structure")}>
            {t("Estructura")}
          </button>
          <button className={view === "ddl" ? "active" : ""} onClick={() => setView("ddl")}>
            {t("DDL")}
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
          <button onClick={() => setFilterInputs({})} title={t("Quitar todos los filtros")}>
            <Icon name="close" size={12} /> Limpiar filtros ({typedFilters})
          </button>
        )}
        {editing && (
          <button onClick={addInsert} title={t("Añadir una fila nueva (no se guarda hasta aplicar los cambios)")}>
            <Icon name="plus" size={13} /> {t("Nueva fila")}
          </button>
        )}
        <button
          className={editMode && canEdit ? "toggled" : ""}
          onClick={() => setEditMode((m) => !m)}
          disabled={(!canEdit && !editMode) || view !== "data"}
          title={editBlock ?? t("Doble clic en una celda para editarla; los cambios esperan hasta que los apliques")}
        >
          <Icon name="edit" size={13} /> {editing ? t("Editando") : t("Editar datos")}
        </button>
        <button
          onClick={() => setImporting(true)}
          disabled={!columns || (structure !== null && structure.kind !== "table")}
          title={t("Importar un CSV o JSON en esta tabla, en una sola transacción")}
        >
          <Icon name="upload" size={13} /> {t("Importar…")}
        </button>
        <button
          onClick={() =>
            page &&
            onPin(
              `${schema}.${table}${applied.length > 0 ? t(" (filtrada)") : ""} · ${t("filas")} ${offset + 1}–${offset + rows.length}`,
              page.result,
            )
          }
          disabled={!page || view !== "data"}
          title={t("Fijar las filas que se ven para compararlas con otro resultado")}
        >
          <Icon name="pin" size={13} /> {t("Fijar")}
        </button>
        <ExportMenu onExport={exportData} disabled={exporting || view !== "data"} />
        <button onClick={refresh} disabled={loading}>
          <Icon name="refresh" size={13} /> {t("Refrescar")}
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
          <button className="ghost icon-btn" onClick={() => setNotice(null)} title={t("Cerrar")}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {count > 0 && (
        <div className="pending-bar">
          <Icon name="edit" size={14} />
          <strong>{count === 1 ? t("1 cambio pendiente") : t("{n} cambios pendientes", { n: count })}</strong>
          <span className="muted">{summarize(pending)} · todavía no se guardó nada en la base</span>
          <span className="spacer" />
          <button onClick={() => setPending(emptyPending)}>{t("Descartar")}</button>
          <button className="primary" onClick={() => void openReview()}>
            {t("Revisar y aplicar…")}
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
                columnTypes={columnTypes}
                fkColumns={fkColumns}
                onFollow={followForeignKey}
                selectionActions={(selectedRows) => (
                  <>
                    {selectedRows.length === 1 && structure && structure.referencedBy.length > 0 && (
                      <select
                        className="small"
                        aria-label={t("Ir a los registros que referencian esta fila")}
                        value=""
                        onChange={(e) => {
                          const fk = structure.referencedBy[Number(e.target.value)];
                          if (fk) followReferences(fk, selectedRows[0]);
                        }}
                      >
                        <option value="" disabled>
                          {t("Referenciada por…")}
                        </option>
                        {structure.referencedBy.map((fk, i) => (
                          <option key={`${fk.schema}.${fk.table}.${fk.name}`} value={i}>
                            {fk.schema}.{fk.table} ({fk.columns.join(", ")})
                          </option>
                        ))}
                      </select>
                    )}
                    {editing && (
                      <button className="small danger" onClick={() => markDeleted(selectedRows)}>
                        <Icon name="trash" size={12} /> {t("Marcar para eliminar")}
                      </button>
                    )}
                  </>
                )}
              />
            )}
            {loading && (
              <div className="loading">
                {t("Cargando…")}
                <button className="danger small" onClick={cancel}>
                  {t("Cancelar")}
                </button>
              </div>
            )}
          </div>
          <div className="statusbar">
            <button
              className="icon-btn"
              title={t("Página anterior")}
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              <Icon name="prev" size={14} />
            </button>
            <button
              className="icon-btn"
              title={t("Página siguiente")}
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
                  {t("{n} por página", { n: s })}
                </option>
              ))}
            </select>
            <span className="muted">
              {rowsShown > 0 ? `${(offset + 1).toLocaleString()}–${(offset + rowsShown).toLocaleString()}` : "0"} · {total}
            </span>
            <button onClick={countExact}>{t("Contar exacto")}</button>
            <span className="spacer" />
            {exporting && (
              <span className="status-running">
                Exportando…{" "}
                <button className="danger small" onClick={cancel}>
                  {t("Cancelar")}
                </button>
              </span>
            )}
            {editing && !exporting && <span className="muted">{t("Doble clic en una celda para editar")}</span>}
            {page && !exporting && !editing && <span className="muted">{page.elapsedMs} ms</span>}
          </div>
        </>
      )}

      {view === "structure" && (
        <div className="grid-host">
          <StructureView
            structure={structure}
            error={structureError}
            onOpenTable={(s, t) => onOpenTable(s, t)}
          />
        </div>
      )}

      {view === "ddl" && (
        <DdlView
          connId={connId}
          schema={schema}
          name={table}
          kind={structure?.kind ?? "table"}
          oid={null}
          onOpenInSql={onOpenInSql}
        />
      )}

      {importing && columns && (
        <ImportDialog
          connId={connId}
          schema={schema}
          table={table}
          columns={columns}
          readOnly={readOnly}
          onClose={() => setImporting(false)}
          onDone={(inserted) => {
            setImporting(false);
            setNotice(t("Se importaron {n} filas en una sola transacción.", { n: inserted.toLocaleString() }));
            refresh();
          }}
        />
      )}

      {review && (
        <div className="modal-backdrop" onMouseDown={() => !review.applying && setReview(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t("Revisar y aplicar cambios")}</h2>
            <p>
              {summarize(pending)} {t("en")} <strong>{schema}.{table}</strong>
              {t(". Todo se ejecuta en una sola transacción: si un cambio falla o la fila cambió mientras tanto, no se aplica ninguno.")}
            </p>
            {review.sql.length === 0 && !review.error && <p className="muted">{t("Preparando…")}</p>}
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
                <span>{t("La sesión está en solo lectura: habilita la escritura para aplicar.")}</span>
              </div>
            )}
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setReview(null)} disabled={review.applying}>
                {t("Cerrar")}
              </button>
              <button
                className="danger"
                disabled={review.applying || readOnly || review.sql.length === 0}
                onClick={() => void applyPending()}
              >
                {review.applying ? t("Aplicando…") : t("Aplicar cambios")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
