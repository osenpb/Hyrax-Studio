import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, type ColumnFilter, type ColumnInfo, type ExportFormat, type TablePage } from "../api";
import { askExportPath } from "../exporting";
import { parseFilters } from "../filters";
import ResultGrid from "./ResultGrid";
import ExportMenu from "./ExportMenu";
import Icon from "./Icon";

interface Props {
  connId: string;
  schema: string;
  table: string;
}

const PAGE_SIZES = [50, 100, 200, 500, 1000];

export default function TableTab({ connId, schema, table }: Props) {
  const [view, setView] = useState<"data" | "structure">("data");
  const [pageSize, setPageSize] = useState(200);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [descending, setDescending] = useState(false);
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
  const lastApplied = useRef("[]");

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
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .tableData(connId, schema, table, pageSize, offset, applied, orderBy, descending)
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connId, schema, table, pageSize, offset, applied, orderBy, descending, reloadKey]);

  useEffect(() => {
    if (view !== "structure") return;
    let cancelled = false;
    api
      .listColumns(connId, schema, table)
      .then((c) => !cancelled && setColumns(c))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [view, connId, schema, table, reloadKey]);

  const sort = useCallback(
    (column: string) => {
      setOffset(0);
      if (orderBy !== column) {
        setOrderBy(column);
        setDescending(false);
      } else if (!descending) {
        setDescending(true);
      } else {
        setOrderBy(null);
        setDescending(false);
      }
    },
    [orderBy, descending],
  );

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
      const result = await api.exportTable(connId, schema, table, applied, orderBy, descending, format, path);
      setNotice(`Se exportaron ${result.rows.toLocaleString()} filas a ${path}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  const changeFilter = (column: string, value: string) =>
    setFilterInputs((prev) => ({ ...prev, [column]: value }));

  const typedFilters = Object.values(filterInputs).filter((v) => v.trim() !== "").length;

  const rowsShown = page?.result.rows.length ?? 0;
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
    <div className="tab-body">
      <div className="toolbar">
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
        <span className="spacer" />
        {typedFilters > 0 && (
          <button onClick={() => setFilterInputs({})} title="Quitar todos los filtros">
            <Icon name="close" size={12} /> Limpiar filtros ({typedFilters})
          </button>
        )}
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

      {view === "data" && (
        <>
          <div className="grid-host">
            {page && (
              <ResultGrid
                result={page.result}
                rowOffset={offset}
                orderBy={orderBy}
                descending={descending}
                onSort={sort}
                filters={filterInputs}
                onFilterChange={changeFilter}
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
            {page && !exporting && <span className="muted">{page.elapsedMs} ms</span>}
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
    </div>
  );
}
