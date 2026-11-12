import { useEffect, useMemo, useState } from "react";
import { api, errorText, type ResultSet } from "../api";
import { copyText } from "../clipboard";
import { cellText, columnsOf, describe, formatJson, formatShell } from "../ejson";
import { buildFilter, buildProjection, buildSort } from "../mongoFilter";
import { mergeSample, suggestFields, suggestFilter } from "../mongoSuggest";
import Icon from "./Icon";
import JsonText from "./JsonText";
import JsonTree from "./JsonTree";
import ResultGrid from "./ResultGrid";
import SuggestInput from "./SuggestInput";
import { t } from "../i18n";

interface Props {
  profileId: string;
  database: string;
  collection: string;
  production: boolean;
}

type Doc = Record<string, unknown>;

type View = "table" | "docs" | "json";
type ViewerMode = "tree" | "doc" | "json";

const VIEW_KEY = "hyrax-mongo-view";
const VIEWER_KEY = "hyrax-mongo-viewer";

/** Preferencia guardada en este equipo (una comodidad: si no se puede leer, se usa el valor por omisión). */
function pref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sin almacenamiento: la elección vale solo para esta pestaña
  }
}

const PAGE_SIZES = [25, 50, 100];

const HELP = 'Filtro rápido: campo=valor, campo!=valor, campo>5, campo>=5, campo<5, campo~texto (contiene, sin distinguir mayúsculas), separados por espacios. Fechas como 2026-03-01 y _id como 24 caracteres hex se convierten solos. También puedes escribir un filtro JSON: { "estado": "OPEN", "edad": { "$gt": 30 } }.';

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
  // Documentos vistos en esta pestaña: de ahí salen las sugerencias de campos y valores.
  const [sample, setSample] = useState<Doc[]>([]);
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
  // Por omisión, el estilo de mongosh; se recuerda lo que el usuario elija.
  const [view, setViewState] = useState<View>(() => pref<View>(VIEW_KEY, ["table", "docs", "json"], "docs"));
  const [viewerMode, setViewerModeState] = useState<ViewerMode>(() =>
    pref<ViewerMode>(VIEWER_KEY, ["tree", "doc", "json"], "doc"),
  );
  const setView = (v: View) => {
    setViewState(v);
    savePref(VIEW_KEY, v);
  };
  const setViewerMode = (m: ViewerMode) => {
    setViewerModeState(m);
    savePref(VIEWER_KEY, m);
  };

  const skip = pageIndex * pageSize;

  // «Documentos» es el estilo de mongosh y de la lista de Compass; «JSON» es JSON extendido.
  const textOf = (mode: "docs" | "json" | "doc", doc: Doc) => (mode === "json" ? formatJson(doc) : formatShell(doc));

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
        setSample((prev) => mergeSample(prev, parsed));
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
      ? exact === 1
        ? t(filtered ? "1 documento con el filtro" : "1 documento")
        : t(filtered ? "{n} documentos con el filtro" : "{n} documentos", { n: exact.toLocaleString() })
      : filtered
        ? t("con filtro: usa Contar exacto")
        : estimated !== null
          ? t("≈ {n} documentos (estimado)", { n: estimated.toLocaleString() })
          : t("total desconocido");

  const knownTotal = exact ?? (!filtered ? estimated : null);
  const rangeText =
    docs.length === 0
      ? "0"
      : knownTotal !== null
        ? t("{a}–{b} de {n}", {
            a: (skip + 1).toLocaleString(),
            b: (skip + docs.length).toLocaleString(),
            n: (exact === null ? "≈ " : "") + knownTotal.toLocaleString(),
          })
        : `${(skip + 1).toLocaleString()}–${(skip + docs.length).toLocaleString()}`;

  const viewed = viewing !== null ? docs[viewing] : null;
  const copy = async (text: string, label: string) => {
    await copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className={"tab-body" + (production ? " is-prod" : "")}>
      <div className="toolbar wrap">
        <div className="segmented" role="group" aria-label={t("Vista")}>
          <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            {t("Tabla")}
          </button>
          <button className={view === "docs" ? "active" : ""} onClick={() => setView("docs")}>
            {t("Documentos")}
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
          title={t("Hyrax solo lee en esta versión. MongoDB no tiene solo lectura por sesión: la protección real es un usuario con el rol read.")}
        >
          <Icon name="lock" size={12} /> {t("Solo lectura")}
        </span>
        <span className="spacer" />
        <button onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
          <Icon name="refresh" size={13} /> {t("Refrescar")}
        </button>
      </div>

      <div className="mongo-query">
        <div className="mongo-query-row">
          <SuggestInput
            className="mongo-filter"
            ariaLabel={t("Filtro")}
            value={filterText}
            placeholder={t('Filtro: estado=ABIERTO edad>30  ·  o JSON { "estado": "ABIERTO" }  ·  Ctrl+Espacio sugiere')}
            title={t(HELP)}
            onChange={setFilterText}
            onSubmit={search}
            suggest={(text, caret, force) => suggestFilter(text, caret, sample, force)}
          />
          <button className="primary" onClick={search} disabled={loading}>
            {t("Buscar")}
          </button>
          <button className="ghost" onClick={() => setOptionsOpen((o) => !o)} aria-expanded={optionsOpen}>
            {t("Orden y campos")}
          </button>
        </div>
        {optionsOpen && (
          <div className="mongo-query-row">
            <SuggestInput
              ariaLabel={t("Orden")}
              value={sortText}
              placeholder={t('Orden: -creado nombre  ·  o { "creado": -1 }')}
              onChange={setSortText}
              onSubmit={search}
              suggest={(text, caret, force) => suggestFields(text, caret, sample, force)}
            />
            <SuggestInput
              ariaLabel={t("Campos")}
              value={projectionText}
              placeholder={t("Campos: nombre email -_id")}
              onChange={setProjectionText}
              onSubmit={search}
              suggest={(text, caret, force) => suggestFields(text, caret, sample, force)}
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
          <span>{t("La página se cortó por tamaño (documentos muy grandes). Usa menos documentos por página o una proyección.")}</span>
        </div>
      )}

      <div className="mongo-results-bar">
        <span className="muted">{total}</span>
        <button className="small" onClick={() => void countExact()} disabled={counting}>
          {counting ? t("Contando…") : t("Contar exacto")}
        </button>
        <span className="spacer" />
        <select
          aria-label={t("Documentos por página")}
          value={pageSize}
          onChange={(e) => {
            setPageIndex(0);
            setPageSize(Number(e.target.value));
          }}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {t("{n} por página", { n: s })}
            </option>
          ))}
        </select>
        <span className="mongo-range">{rangeText}</span>
        <button
          className="icon-btn"
          title={t("Página anterior")}
          disabled={pageIndex === 0 || loading}
          onClick={() => setPageIndex(pageIndex - 1)}
        >
          <Icon name="prev" size={14} />
        </button>
        <button className="icon-btn" title={t("Página siguiente")} disabled={!hasNext || loading} onClick={() => setPageIndex(pageIndex + 1)}>
          <Icon name="next" size={14} />
        </button>
      </div>

      <div className={"mongo-body" + (viewed ? " with-viewer" : "")}>
        <div className="grid-host">
          {!loading && !error && docs.length === 0 ? (
            <div className="empty-hint">
              <p>{filtered ? t("Ningún documento coincide con el filtro.") : t("La colección está vacía.")}</p>
            </div>
          ) : view !== "table" ? (
            <div className="json-list" aria-label={view === "json" ? t("Documentos en JSON") : t("Lista de documentos")}>
              {docs.map((d, i) => (
                <section key={skip + i} className="json-doc">
                  <header>
                    <span className="muted">
                      #{(skip + i + 1).toLocaleString()} · {describe(d._id).text}
                    </span>
                    <button className="ghost small" onClick={() => void copy(textOf(view, d), `doc${i}`)}>
                      <Icon name="copy" size={12} /> {copied === `doc${i}` ? t("Copiado") : t("Copiar")}
                    </button>
                  </header>
                  <JsonText text={textOf(view, d)} kind={view === "json" ? "json" : "shell"} />
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
                    <Icon name="form" size={12} /> {t("Ver documento")}
                  </button>
                ) : null
              }
            />
          )}
          {loading && <div className="loading">{t("Cargando…")}</div>}
        </div>
        {viewed && (
          <aside className="doc-viewer" aria-label={t("Documento")}>
            <div className="doc-viewer-head">
              <strong>{t("Documento")}</strong>
              <span className="muted">{describe(viewed._id).text}</span>
              <div className="segmented" role="group" aria-label={t("Formato del documento")}>
                <button className={viewerMode === "tree" ? "active" : ""} onClick={() => setViewerMode("tree")}>
                  {t("Árbol")}
                </button>
                <button className={viewerMode === "doc" ? "active" : ""} onClick={() => setViewerMode("doc")}>
                  {t("Documento")}
                </button>
                <button className={viewerMode === "json" ? "active" : ""} onClick={() => setViewerMode("json")}>
                  JSON
                </button>
              </div>
              <span className="spacer" />
              <button
                className="small"
                onClick={() =>
                  void copy(viewerMode === "tree" ? JSON.stringify(viewed, null, 2) : textOf(viewerMode, viewed), "viewer")
                }
                title={
                  viewerMode === "tree"
                    ? t("Copia el documento como JSON extendido canónico (conserva todos los tipos BSON)")
                    : viewerMode === "doc"
                      ? t("Copia el documento al estilo de mongosh")
                      : t("Copia el documento como JSON")
                }
              >
                <Icon name="copy" size={12} /> {copied === "viewer" ? t("Copiado") : t("Copiar JSON")}
              </button>
              <button className="ghost icon-btn" onClick={() => setViewing(null)} title={t("Cerrar")}>
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="doc-viewer-body">
              {viewerMode === "tree" ? (
                <JsonTree value={viewed} openDepth={2} />
              ) : (
                <JsonText text={textOf(viewerMode, viewed)} kind={viewerMode === "json" ? "json" : "shell"} />
              )}
            </div>
          </aside>
        )}
      </div>

      <div className="statusbar">
        <span className="spacer" />
        {elapsed !== null && <span className="muted">{elapsed} ms</span>}
      </div>
    </div>
  );
}
