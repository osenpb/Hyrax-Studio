import { useMemo, useState } from "react";
import { api, errorText, type ColumnInfo } from "../api";
import {
  DELIMITERS,
  MAX_IMPORT_ROWS,
  applyMapping,
  autoMap,
  csvToTabular,
  detectDelimiter,
  parseCsv,
  parseJsonRows,
  type Tabular,
} from "../tabular";
import Icon from "./Icon";
import { t } from "../i18n";

interface Props {
  connId: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  readOnly: boolean;
  onClose: () => void;
  onDone: (inserted: number) => void;
}

interface Loaded {
  name: string;
  path: string;
  text: string;
  json: boolean;
}

const DELIMITER_LABEL: Record<string, string> = { ",": "coma ( , )", ";": "punto y coma ( ; )", "\t": "tabulador", "|": "barra ( | )" };

export default function ImportDialog({ connId, schema, table, columns, readOnly, onClose, onDone }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [trim, setTrim] = useState(false);
  const [mapping, setMapping] = useState<(number | null)[]>([]);
  const [busy, setBusy] = useState<"dry" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const targets = columns.map((c) => c.name);

  const parsed = useMemo<{ table: Tabular | null; error: string | null }>(() => {
    if (!loaded) return { table: null, error: null };
    try {
      const data = loaded.json
        ? parseJsonRows(loaded.text)
        : csvToTabular(parseCsv(loaded.text, delimiter), hasHeader);
      return { table: data, error: null };
    } catch (e) {
      return { table: null, error: errorText(e) };
    }
  }, [loaded, delimiter, hasHeader]);

  const source = parsed.table;
  const tooMany = source !== null && source.rows.length > MAX_IMPORT_ROWS;

  const chooseFile = async () => {
    setError(null);
    setMessage(null);
    try {
      const file = await api.openTextFile("data");
      if (!file) return;
      const json = /\.json$/i.test(file.name);
      const next: Loaded = { name: file.name, path: file.path, text: file.content, json };
      const delim = json ? "," : detectDelimiter(file.content);
      setLoaded(next);
      setDelimiter(delim);
      const data = json ? parseJsonRows(file.content) : csvToTabular(parseCsv(file.content, delim), true);
      setMapping(autoMap(targets, data.headers));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remap = (nextHeader: boolean, nextDelimiter: string) => {
    if (!loaded || loaded.json) return;
    try {
      const data = csvToTabular(parseCsv(loaded.text, nextDelimiter), nextHeader);
      setMapping(autoMap(targets, data.headers));
    } catch {
      setMapping([]);
    }
  };

  const prepared = useMemo(
    () => (source ? applyMapping(source, targets, mapping, { emptyAsNull, trim }) : null),
    [source, mapping, emptyAsNull, trim],
  );
  const mappedCount = prepared?.columns.length ?? 0;
  const canRun = source !== null && !tooMany && mappedCount > 0 && source.rows.length > 0 && busy === null;

  const run = async (dryRun: boolean) => {
    if (!prepared) return;
    setBusy(dryRun ? "dry" : "import");
    setError(null);
    setMessage(null);
    try {
      const result = await api.importRows(connId, schema, table, prepared.columns, prepared.rows, dryRun);
      if (dryRun) {
        setMessage(
          t("Ensayo correcto: se insertarían {n} filas. Se hizo ROLLBACK, no se guardó nada.", { n: result.inserted.toLocaleString() }),
        );
      } else {
        onDone(result.inserted);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => busy === null && onClose()}>
      <div className="modal import-dialog" role="dialog" aria-label={t("Importar datos")} onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          {t("Importar en")} {schema}.{table}
        </h2>
        <p className="muted">
          {t("Admite CSV, TSV y JSON (arreglo de objetos o una línea JSON por fila). Todas las filas se insertan en una sola transacción: si una falla, no se importa ninguna.")}
        </p>

        <div className="import-file">
          <button onClick={() => void chooseFile()} disabled={busy !== null}>
            <Icon name="file" size={13} /> {loaded ? t("Elegir otro archivo…") : t("Elegir archivo…")}
          </button>
          {loaded && (
            <span className="muted" title={loaded.path}>
              {loaded.name}
              {source ? ` · ${source.rows.length.toLocaleString()} ${t("filas")} · ${source.headers.length} ${t("columnas")}` : ""}
            </span>
          )}
        </div>

        {loaded && !loaded.json && (
          <div className="import-options">
            <label className="inline-select">
              {t("Separador")}
              <select
                value={delimiter}
                onChange={(e) => {
                  setDelimiter(e.target.value);
                  remap(hasHeader, e.target.value);
                }}
              >
                {DELIMITERS.map((d) => (
                  <option key={d} value={d}>
                    {t(DELIMITER_LABEL[d])}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked);
                  remap(e.target.checked, delimiter);
                }}
              />
              {t("La primera fila son encabezados")}
            </label>
          </div>
        )}
        {loaded && (
          <div className="import-options">
            <label className="inline-check">
              <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} />
              {t("Texto vacío = NULL")}
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
              {t("Quitar espacios al inicio y al final")}
            </label>
          </div>
        )}

        {parsed.error && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>{parsed.error}</span>
          </div>
        )}
        {tooMany && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>
              El archivo tiene {source!.rows.length.toLocaleString()} filas y el máximo por importación es{" "}
              {MAX_IMPORT_ROWS.toLocaleString()}. Divídelo en varios archivos.
            </span>
          </div>
        )}

        {source && (
          <>
            <div className="import-map">
              <div className="import-map-head">
                <span>{t("Columna de destino")}</span>
                <span>{t("Se llena con")}</span>
              </div>
              {columns.map((c, i) => (
                <div key={c.name} className="import-map-row">
                  <span title={c.dataType}>
                    {c.name} <span className="muted">{c.dataType}</span>
                    {!c.nullable && c.default === null && <span className="tag tag-warn">{t("obligatoria")}</span>}
                  </span>
                  <select
                    aria-label={t("Origen de {name}", { name: c.name })}
                    value={mapping[i] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = [...m];
                        next[i] = e.target.value === "" ? null : Number(e.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="">{t("— no importar (usa el valor por defecto) —")}</option>
                    {source.headers.map((h, k) => (
                      <option key={k} value={k}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {prepared && mappedCount > 0 && (
              <div className="import-preview">
                <div className="muted">Vista previa (primeras {Math.min(6, prepared.rows.length)} filas)</div>
                <div className="grid-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        {prepared.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {prepared.rows.slice(0, 6).map((row, r) => (
                        <tr key={r}>
                          {row.map((v, k) => (
                            <td key={k} className={v === null ? "null" : ""}>
                              {v === null ? "NULL" : v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {mappedCount === 0 && <p className="muted">{t("Elige al menos una columna de origen para importar.")}</p>}
          </>
        )}

        {readOnly && (
          <div className="alert alert-warn">
            <Icon name="lock" size={15} />
            <span>{t("La sesión está en solo lectura: habilita la escritura para ensayar o importar.")}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}
        {message && (
          <div className="alert alert-ok">
            <Icon name="lock" size={15} />
            <span>{message}</span>
          </div>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose} disabled={busy !== null}>
            {t("Cerrar")}
          </button>
          <button
            onClick={() => void run(true)}
            disabled={!canRun || readOnly}
            title={t("Inserta todas las filas dentro de una transacción y la revierte")}
          >
            {busy === "dry" ? t("Ensayando…") : t("Ensayar (ROLLBACK)")}
          </button>
          <button className="danger" onClick={() => void run(false)} disabled={!canRun || readOnly}>
            {busy === "import" ? t("Importando…") : t("Importar {n} filas", { n: source ? source.rows.length.toLocaleString() : "" })}
          </button>
        </div>
      </div>
    </div>
  );
}
