import { useEffect, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import {
  api,
  databaseOfSession,
  errorText,
  profileOfSession,
  type ExportFormat,
  type QueryOutput,
  type ResultSet,
} from "../api";
import { findDangers, type Danger } from "../sqlscan";
import { substituteParams, uniqueParams } from "../params";
import { parsePlan } from "../plan";
import { askExportPath } from "../exporting";
import {
  addHistory,
  clearHistory,
  historyEnabled,
  loadHistory,
  setHistoryEnabled,
  type HistoryItem,
} from "../history";
import ResultGrid from "./ResultGrid";
import ExportMenu from "./ExportMenu";
import ModeChip from "./ModeChip";
import ParamsDialog from "./ParamsDialog";
import PlanTree from "./PlanTree";
import SqlEditor, { type SqlEditorHandle } from "./SqlEditor";
import Icon from "./Icon";

interface Props {
  connId: string;
  connName: string;
  readOnly: boolean;
  production: boolean;
  initialSql?: string;
  onSetReadOnly: (readOnly: boolean, confirm?: string) => Promise<void>;
  onTitle: (title: string) => void;
  onPin: (label: string, result: ResultSet) => void;
}

const ROW_LIMIT = 5000;

const TIMEOUTS = [
  { ms: 15000, label: "15 s" },
  { ms: 60000, label: "1 min" },
  { ms: 300000, label: "5 min" },
  { ms: 0, label: "Sin límite" },
];

const stripTrailing = (text: string) => text.trim().replace(/;+\s*$/, "");

interface ParamAsk {
  names: string[];
  done: (values: Record<string, string | null> | null) => void;
}

export default function SqlTab({
  connId,
  connName,
  readOnly,
  production,
  initialSql,
  onSetReadOnly,
  onTitle,
  onPin,
}: Props) {
  const profileId = profileOfSession(connId);
  const editor = useRef<SqlEditorHandle>(null);
  const [output, setOutput] = useState<QueryOutput | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [danger, setDanger] = useState<{ text: string; dangers: Danger[] } | null>(null);
  const [dry, setDry] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOn, setHistoryOn] = useState(historyEnabled);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; name: string } | null>(null);
  const [paramAsk, setParamAsk] = useState<ParamAsk | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory(profileId));
  const lastParams = useRef<Record<string, string | null>>({});
  const runner = useRef<(all: boolean) => void>(() => undefined);
  const formatter = useRef<() => void>(() => undefined);
  const saver = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let cancelled = false;
    api
      .completionSchema(connId)
      .then((tables) => {
        if (cancelled) return;
        const schema: Record<string, string[]> = {};
        for (const t of tables) {
          schema[`${t.schema}.${t.table}`] = t.columns;
          if (t.schema === "public") schema[t.table] = t.columns;
        }
        editor.current?.setSchema(schema);
      })
      .catch(() => undefined);
    Promise.all([api.searchObjects(connId).catch(() => []), api.completionFks(connId).catch(() => [])]).then(
      ([objects, fks]) => {
        if (cancelled) return;
        editor.current?.setExtras({
          functions: objects.filter((o) => o.kind === "function" || o.kind === "procedure"),
          fks,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connId]);

  const withParams = (text: string): Promise<string | null> => {
    const names = uniqueParams(text);
    if (names.length === 0) return Promise.resolve(text);
    return new Promise((resolve) => {
      setParamAsk({
        names,
        done: (values) => {
          setParamAsk(null);
          if (!values) return resolve(null);
          lastParams.current = { ...lastParams.current, ...values };
          try {
            resolve(substituteParams(text, values));
          } catch (e) {
            setError(errorText(e));
            resolve(null);
          }
        },
      });
    });
  };

  const execute = async (text: string, record: boolean, dryRun = false) => {
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setDry(dryRun);
    let ok = false;
    let ms: number | null = null;
    try {
      const out = dryRun
        ? await api.runSqlDry(connId, text, ROW_LIMIT, timeoutMs)
        : await api.runSql(connId, text, ROW_LIMIT, timeoutMs);
      setOutput(out);
      setActive(0);
      ok = true;
      ms = out.elapsedMs;
    } catch (e) {
      setOutput(null);
      setError(errorText(e));
    } finally {
      setRunning(false);
      if (record && historyOn) setHistory(addHistory(profileId, { sql: text.trim(), at: Date.now(), ms, ok }));
    }
  };

  const run = async (all: boolean) => {
    const raw = all ? (editor.current?.getRunnable() ?? "") : (editor.current?.getStatement() ?? "");
    if (!raw.trim() || running) return;
    const text = await withParams(raw);
    if (text === null) return;
    if (!readOnly) {
      const dangers = findDangers(text);
      if (dangers.length > 0) {
        setDanger({ text, dangers });
        return;
      }
    }
    return execute(text, true);
  };

  const dryRun = async () => {
    const raw = editor.current?.getRunnable() ?? "";
    const text = await withParams(raw);
    if (text !== null) await execute(text, false, true);
  };

  const explain = async (analyze: boolean) => {
    const raw = stripTrailing(editor.current?.getStatement() ?? "");
    if (!raw) return;
    const text = await withParams(raw);
    if (text === null) return;
    if (/^\s*explain\b/i.test(text)) return execute(text, false);
    return execute(`EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${text}`, false);
  };

  const exportResult = async (format: ExportFormat) => {
    const raw = editor.current?.getStatement() ?? "";
    if (!raw.trim()) return;
    setNotice(null);
    const text = await withParams(raw);
    if (text === null) return;
    const path = await askExportPath("consulta", format);
    if (!path) return;
    setExporting(true);
    setError(null);
    try {
      const result = await api.exportSql(connId, text, format, path);
      setNotice(`Se exportaron ${result.rows.toLocaleString()} filas a ${path}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  const formatCode = () => {
    try {
      editor.current?.transform((text) =>
        formatSql(text, { language: "postgresql", keywordCase: "upper", tabWidth: 2 }),
      );
      setError(null);
    } catch (e) {
      setError(`No se pudo formatear: ${errorText(e)}`);
    }
  };

  const openFile = async () => {
    setError(null);
    try {
      const opened = await api.openTextFile("sql");
      if (!opened) return;
      editor.current?.setText(opened.content);
      setFile({ path: opened.path, name: opened.name });
      onTitle(opened.name);
      setNotice(`Abierto ${opened.path}. Ctrl+Z recupera lo que había antes en el editor.`);
      editor.current?.focus();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const saveFile = async (asNew: boolean) => {
    setError(null);
    try {
      const saved = await api.saveTextFile(
        editor.current?.getAll() ?? "",
        file?.name ?? "consulta.sql",
        asNew ? null : (file?.path ?? null),
      );
      if (!saved) return;
      setFile({ path: saved.path, name: saved.name });
      onTitle(saved.name);
      setNotice(`Guardado en ${saved.path}`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  runner.current = (all) => void run(all);
  formatter.current = formatCode;
  saver.current = () => void saveFile(false);

  const cancel = () => {
    api.cancelQuery(connId).catch(() => undefined);
  };

  const pick = (item: HistoryItem) => {
    editor.current?.setText(item.sql);
    setHistoryOpen(false);
    editor.current?.focus();
  };

  const current = output?.results[active];
  const soft = error !== null && /^(Consulta cancelada|Tiempo de espera)/.test(error);
  const isPlan = current?.columns.length === 1 && current.columns[0] === "QUERY PLAN";
  const planText = isPlan ? (current?.rows[0]?.[0] ?? "") : "";
  const plan = isPlan && current && current.rows.length === 1 ? parsePlan(planText) : null;
  const pinnable = current !== undefined && current.columns.length > 0 && !isPlan;

  return (
    <div className={"tab-body" + (production ? " is-prod" : "")}>
      <div className="toolbar wrap">
        {running ? (
          <button className="danger" onClick={cancel}>
            <Icon name="stop" size={12} /> Cancelar
          </button>
        ) : (
          <>
            <button
              className="primary"
              onClick={() => void run(false)}
              title="Ejecuta la selección o, si no hay, la sentencia donde está el cursor (Ctrl+Enter)"
            >
              <Icon name="play" size={12} /> Ejecutar
            </button>
            <button onClick={() => void run(true)} title="Ejecuta la selección o todo el script (Ctrl+Mayús+Enter)">
              Ejecutar todo
            </button>
          </>
        )}
        <button onClick={() => void explain(false)} disabled={running} title="EXPLAIN: muestra el plan sin ejecutar la consulta">
          Explicar
        </button>
        <button
          onClick={() => void explain(true)}
          disabled={running || !readOnly}
          title={
            readOnly
              ? "EXPLAIN ANALYZE: ejecuta la consulta y muestra tiempos reales"
              : "ANALYZE ejecuta la consulta de verdad: solo disponible en modo solo lectura"
          }
        >
          Analizar
        </button>
        <button onClick={formatCode} title="Formatear SQL (Mayús+Alt+F). Si hay selección, solo formatea la selección.">
          Formatear
        </button>
        <button onClick={() => void openFile()} title="Abrir un script .sql">
          <Icon name="folder" size={12} /> Abrir…
        </button>
        <button
          onClick={() => void saveFile(false)}
          title={file ? `Guardar en ${file.path} (Ctrl+S)` : "Guardar el script en un archivo .sql (Ctrl+S)"}
        >
          <Icon name="save" size={12} /> Guardar
        </button>
        {file && (
          <button onClick={() => void saveFile(true)} title="Guardar una copia con otro nombre">
            Guardar como…
          </button>
        )}
        <button
          className={historyOpen ? "toggled" : ""}
          onClick={() => setHistoryOpen((o) => !o)}
          title="Consultas ejecutadas anteriormente en este servidor"
        >
          Historial{history.length > 0 ? ` (${history.length})` : ""}
        </button>
        <ExportMenu onExport={exportResult} disabled={running || exporting} />
        <label className="inline-select" title="Tiempo máximo por consulta">
          Límite
          <select value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} disabled={running}>
            {(production ? TIMEOUTS.filter((t) => t.ms !== 0) : TIMEOUTS).map((t) => (
              <option key={t.ms} value={t.ms}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {!readOnly && (
          <button
            onClick={() => void dryRun()}
            disabled={running}
            title="Ejecuta la consulta dentro de una transacción y la revierte (ROLLBACK): ves el efecto sin guardar nada"
          >
            Probar (ROLLBACK)
          </button>
        )}
        <ModeChip
          readOnly={readOnly}
          production={production}
          database={databaseOfSession(connId)}
          onSet={onSetReadOnly}
          onError={setError}
        />
        <span className="spacer" />
        <span className="chip chip-plain">
          <Icon name="database" size={13} /> {connName}
        </span>
      </div>

      {paramAsk && (
        <ParamsDialog
          names={paramAsk.names}
          initial={lastParams.current}
          onSubmit={(values) => paramAsk.done(values)}
          onCancel={() => paramAsk.done(null)}
        />
      )}

      {danger && (
        <div className="modal-backdrop" onMouseDown={() => setDanger(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Sentencia peligrosa</h2>
            <p>
              La escritura está habilitada en <strong>{connName}</strong>. Esta ejecución incluye:
            </p>
            <ul className="danger-list">
              {danger.dangers.map((d, i) => (
                <li key={i}>
                  <strong>{d.label}</strong>
                  <code>{d.statement}</code>
                </li>
              ))}
            </ul>
            <p className="muted">
              Puedes probarla primero con ROLLBACK para ver cuántas filas afectaría sin guardar nada.
            </p>
            <div className="modal-actions">
              <button onClick={() => setDanger(null)}>Cancelar</button>
              <span className="spacer" />
              <button
                onClick={() => {
                  const text = danger.text;
                  setDanger(null);
                  void execute(text, false, true);
                }}
              >
                Probar con ROLLBACK
              </button>
              <button
                className="danger"
                onClick={() => {
                  const text = danger.text;
                  setDanger(null);
                  void execute(text, true);
                }}
              >
                Ejecutar de todos modos
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="history-panel">
          <div className="history-head">
            <strong>Historial</strong>
            <span className="muted">Clic para cargar la consulta en el editor</span>
            <span className="spacer" />
            <label className="inline-check" title="Las consultas pueden contener datos sensibles; se guardan en este equipo sin cifrar">
              <input
                type="checkbox"
                checked={historyOn}
                onChange={(e) => {
                  setHistoryOn(e.target.checked);
                  setHistoryEnabled(e.target.checked);
                }}
              />
              Guardar historial
            </label>
            <button
              className="small"
              disabled={history.length === 0}
              onClick={() => {
                clearHistory(profileId);
                setHistory([]);
              }}
            >
              <Icon name="trash" size={12} /> Vaciar
            </button>
            <button className="ghost icon-btn" onClick={() => setHistoryOpen(false)} title="Cerrar">
              <Icon name="close" size={13} />
            </button>
          </div>
          {history.length === 0 && <div className="history-empty">Todavía no hay consultas ejecutadas.</div>}
          <div className="history-list">
            {history.map((h) => (
              <button key={h.sql} className="history-item" onClick={() => pick(h)} title={h.sql}>
                <span className={"dot " + (h.ok ? "dot-ok" : "dot-bad")} />
                <code>{h.sql.replace(/\s+/g, " ")}</code>
                <span className="muted when">
                  {new Date(h.at).toLocaleString()}
                  {h.ms !== null ? ` · ${h.ms} ms` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <SqlEditor
        ref={editor}
        initialValue={initialSql ?? "SELECT 1;"}
        onRun={(all) => runner.current(all)}
        onFormat={() => formatter.current()}
        onSave={() => saver.current()}
      />

      {notice && (
        <div className="alert alert-ok">
          <Icon name="download" size={15} />
          <span>{notice}</span>
          <button className="ghost icon-btn" onClick={() => setNotice(null)} title="Cerrar">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {error && (
        <div className={"alert " + (soft ? "alert-warn" : "alert-error")}>
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}

      {output && dry && (
        <div className="alert alert-ok">
          <Icon name="lock" size={15} />
          <span>Ensayo: se ejecutó dentro de una transacción y se revirtió (ROLLBACK). No se guardó ningún cambio.</span>
        </div>
      )}

      {output && (
        <>
          {output.results.length > 1 && (
            <div className="subtabs">
              {output.results.map((r, i) => (
                <button key={i} className={i === active ? "active" : ""} onClick={() => setActive(i)}>
                  Resultado {i + 1}
                  {r.columns.length === 0 ? " (comando)" : ` (${r.totalRows.toLocaleString()}${r.totalIsLowerBound ? "+" : ""})`}
                </button>
              ))}
            </div>
          )}
          <div className="grid-host">
            {current && plan && <PlanTree plan={plan} raw={planText} />}
            {current && isPlan && !plan && (
              <pre className="plan">{current.rows.map((r) => r[0] ?? "").join("\n")}</pre>
            )}
            {current && !isPlan && <ResultGrid result={current} />}
          </div>
        </>
      )}

      <div className="statusbar">
        {running && <span className="status-running">Ejecutando… {(elapsed / 1000).toFixed(1)} s</span>}
        {exporting && (
          <span className="status-running">
            Exportando…{" "}
            <button className="danger small" onClick={cancel}>
              Cancelar
            </button>
          </span>
        )}
        {!running && current && current.columns.length > 0 && !isPlan && (
          <span className="muted">
            {current.totalRows.toLocaleString()}
            {current.totalIsLowerBound ? "+" : ""} filas
            {current.truncated ? ` · mostrando las primeras ${ROW_LIMIT.toLocaleString()}` : ""}
          </span>
        )}
        {!running && isPlan && <span className="muted">Plan de ejecución</span>}
        {!running && !output && !error && (
          <span className="muted">Ctrl+Enter ejecuta la sentencia del cursor · Ctrl+Mayús+Enter ejecuta todo</span>
        )}
        <span className="spacer" />
        {pinnable && current && (
          <button
            className="small"
            title="Fijar este resultado para compararlo con otro después"
            onClick={() => onPin(`${file?.name ?? "SQL"} · ${new Date().toLocaleTimeString()}`, current)}
          >
            <Icon name="pin" size={12} /> Fijar resultado
          </button>
        )}
        {!running && output && <span className="muted">{output.elapsedMs} ms</span>}
      </div>
    </div>
  );
}
