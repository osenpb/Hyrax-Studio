import { useEffect, useMemo, useState } from "react";
import { api, errorText, type ResultSet } from "../api";
import { copyText } from "../clipboard";
import { cellText, columnsOf, describe, formatJson } from "../ejson";
import { buildFilter, buildProjection, buildSort } from "../mongoFilter";
import Icon from "./Icon";
import JsonText from "./JsonText";
import JsonTree from "./JsonTree";
import ResultGrid from "./ResultGrid";

interface Props {
  profileId: string;
  database: string;
  collection: string;
  production: boolean;
}

type Doc = Record<string, unknown>;

const PAGE_SIZES = [25, 50, 100];

const HELP =
  "Filtro rápido: campo=valor, campo!=valor, campo>5, campo>=5, campo<5, campo~texto (contiene, sin distinguir mayúsculas), " +
  "separados por espacios. Fechas como 2026-03-01 y _id como 24 caracteres hex se convierten solos. " +
  'También puedes escribir un filtro JSON: { "estado": "OPEN", "edad": { "$gt": 30 } }.';

export default function MongoCollectionTab({ profileId, database, collection, production }: Props) {
  const [filterText, setFilterText] = useState("");
  const [sortText, setSortText] = useState("");
  const [projectionText, setProjectionText] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [applied, setApplied] = useState({ filter: "", sort: "", projection: "" });
  const [inputError, setInputError] = useState<string | null>(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [reloadKey, setReloadKey] = useState(0);

  const [docs, setDocs] = useState<Doc[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [estimated, setEstimated] = useState<number | null>(null);
  const [exact, setExact] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  const [viewing, setViewing] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Vista de la colección (tabla o lista de documentos en JSON) y del visor de un documento (árbol o JSON).
  const [view, setView] = useState<"table" | "json">("table");
  const [viewerMode, setViewerMode] = useState<"tree" | "json">("tree");

  const skip = pageIndex * pageSize;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .mongoFind(profileId, database, collection, applied.filter, applied.sort, applied.projection, skip, pageSize + 1)
      .then((page) => {
        if (cancelled) return;
        const parsed = page.documents.map((d) => JSON.parse(d) as Doc);
        setHasNext(parsed.length > pageSize);
        setDocs(parsed.slice(0, pageSize));
        setTruncated(page.truncated);
        setElapsed(page.elapsedMs);
        setViewing(null);
      })
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profileId, database, collection, applied, skip, pageSize, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setExact(null);
    api
      .mongoEstimatedCount(profileId, database, collection)
      .then((n) => !cancelled && setEstimated(n))
      .catch(() => !cancelled && setEstimated(null));
    return () => {
      cancelled = true;
    };
  }, [profileId, database, collection, reloadKey]);

  useEffect(() => setExact(null), [applied]);

  const search = () => {
    try {
      setApplied({ filter: buildFilter(filterText), sort: buildSort(sortText), projection: buildProjection(projectionText) });
      setPageIndex(0);
      setInputError(null);
    } catch (e) {
      setInputError(errorText(e));
    }
  };

  const countExact = async () => {
    setCounting(true);
    try {
      setExact(await api.mongoCount(profileId, database, collection, applied.filter));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCounting(false);
    }
  };

  const result: ResultSet = useMemo(() => {
    const columns = columnsOf(docs);
    return {
      columns,
      rows: docs.map((d) => columns.map((c) => cellText(d[c]))),
      totalRows: docs.length,
      truncated: false,
      totalIsLowerBound: false,
      affected: null,
    };
  }, [docs]);

  const filtered = applied.filter !== "";
  const total =
    exact !== null
      ? `${exact.toLocaleString()} ${exact === 1 ? "documento" : "documentos"}${filtered ? " con el filtro" : ""}`
      : filtered
        ? "con filtro: usa Contar exacto"
        : estimated !== null
          ? `≈ ${estimated.toLocaleString()} documentos (estimado)`
          : "total desconocido";

  const viewed = viewing !== null ? docs[viewing] : null;
  const copy = async (text: string, label: string) => {
    await copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className={"tab-body" + (production ? " is-prod" : "")}>
      <div className="toolbar wrap">
        <div className="segmented" role="group" aria-label="Vista">
          <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            Tabla
          </button>
          <button className={view === "json" ? "active" : ""} onClick={() => setView("json")}>
            JSON
          </button>
        </div>
        <span className="chip chip-plain">
          <Icon name="table" size={13} /> {database}.{collection}
        </span>
        <span
          className="chip chip-plain"
          title="Hyrax solo lee en esta versión. MongoDB no tiene solo lectura por sesión: la protección real es un usuario con el rol read."
        >
          <Icon name="lock" size={12} /> Solo lectura
        </span>
        <span className="spacer" />
        <button onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
          <Icon name="refresh" size={13} /> Refrescar
        </button>
      </div>

      <div className="mongo-query">
        <div className="mongo-query-row">
          <input
            className="mongo-filter"
            aria-label="Filtro"
            spellCheck={false}
            autoComplete="off"
            value={filterText}
            placeholder='Filtro: status=OPEN age>30  ·  o JSON { "status": "OPEN" }'
            title={HELP}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button className="primary" onClick={search} disabled={loading}>
            Buscar
          </button>
          <button className="ghost" onClick={() => setOptionsOpen((o) => !o)} aria-expanded={optionsOpen}>
            Orden y campos
          </button>
        </div>
        {optionsOpen && (
          <div className="mongo-query-row">
            <input
              aria-label="Orden"
              spellCheck={false}
              value={sortText}
              placeholder="Orden: -creado nombre  ·  o { &quot;creado&quot;: -1 }"
              onChange={(e) => setSortText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <input
              aria-label="Campos"
              spellCheck={false}
              value={projectionText}
              placeholder="Campos: nombre email -_id"
              onChange={(e) => setProjectionText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
          </div>
        )}
        {inputError && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>{inputError}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}
      {truncated && (
        <div className="alert alert-warn">
          <Icon name="alert" size={15} />
          <span>La página se cortó por tamaño (documentos muy grandes). Usa menos documentos por página o una proyección.</span>
        </div>
      )}

      <div className={"mongo-body" + (viewed ? " with-viewer" : "")}>
        <div className="grid-host">
          {!loading && !error && docs.length === 0 ? (
            <div className="empty-hint">
              <p>{filtered ? "Ningún documento coincide con el filtro." : "La colección está vacía."}</p>
            </div>
          ) : view === "json" ? (
            <div className="json-list" aria-label="Documentos en JSON">
              {docs.map((d, i) => (
                <section key={skip + i} className="json-doc">
                  <header>
                    <span className="muted">
                      #{(skip + i + 1).toLocaleString()} · {describe(d._id).text}
                    </span>
                    <button className="ghost small" onClick={() => void copy(formatJson(d), `doc${i}`)}>
                      <Icon name="copy" size={12} /> {copied === `doc${i}` ? "Copiado" : "Copiar"}
                    </button>
                  </header>
                  <JsonText text={formatJson(d)} />
                </section>
              ))}
            </div>
          ) : (
            <ResultGrid
              result={result}
              rowOffset={skip}
              selectionActions={(rows) =>
                rows.length === 1 ? (
                  <button className="small" onClick={() => setViewing(rows[0])}>
                    <Icon name="form" size={12} /> Ver documento
                  </button>
                ) : null
              }
            />
          )}
          {loading && <div className="loading">Cargando…</div>}
        </div>
        {viewed && (
          <aside className="doc-viewer" aria-label="Documento">
            <div className="doc-viewer-head">
              <strong>Documento</strong>
              <span className="muted">{describe(viewed._id).text}</span>
              <div className="segmented" role="group" aria-label="Formato del documento">
                <button className={viewerMode === "tree" ? "active" : ""} onClick={() => setViewerMode("tree")}>
                  Árbol
                </button>
                <button className={viewerMode === "json" ? "active" : ""} onClick={() => setViewerMode("json")}>
                  JSON
                </button>
              </div>
              <span className="spacer" />
              <button
                className="small"
                onClick={() =>
                  void copy(viewerMode === "json" ? formatJson(viewed) : JSON.stringify(viewed, null, 2), "viewer")
                }
                title={
                  viewerMode === "json"
                    ? "Copia el documento como JSON"
                    : "Copia el documento como JSON extendido canónico (conserva todos los tipos BSON)"
                }
              >
                <Icon name="copy" size={12} /> {copied === "viewer" ? "Copiado" : "Copiar JSON"}
              </button>
              <button className="ghost icon-btn" onClick={() => setViewing(null)} title="Cerrar">
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="doc-viewer-body">
              {viewerMode === "json" ? <JsonText text={formatJson(viewed)} /> : <JsonTree value={viewed} openDepth={2} />}
            </div>
          </aside>
        )}
      </div>

      <div className="statusbar">
        <button
          className="icon-btn"
          title="Página anterior"
          disabled={pageIndex === 0 || loading}
          onClick={() => setPageIndex(pageIndex - 1)}
        >
          <Icon name="prev" size={14} />
        </button>
        <button className="icon-btn" title="Página siguiente" disabled={!hasNext || loading} onClick={() => setPageIndex(pageIndex + 1)}>
          <Icon name="next" size={14} />
        </button>
        <select
          aria-label="Documentos por página"
          value={pageSize}
          onChange={(e) => {
            setPageIndex(0);
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
          {docs.length > 0 ? `${(skip + 1).toLocaleString()}–${(skip + docs.length).toLocaleString()}` : "0"} · {total}
        </span>
        <button onClick={() => void countExact()} disabled={counting}>
          {counting ? "Contando…" : "Contar exacto"}
        </button>
        <span className="spacer" />
        {elapsed !== null && <span className="muted">{elapsed} ms</span>}
      </div>
    </div>
  );
}
