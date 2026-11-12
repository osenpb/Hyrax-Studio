import { useState } from "react";
import { t } from "../i18n";

interface Props {
  names: string[];
  initial: Record<string, string | null>;
  onSubmit: (values: Record<string, string | null>) => void;
  onCancel: () => void;
}

export default function ParamsDialog({ names, initial, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((n) => [n, initial[n] ?? ""])),
  );
  const [nulls, setNulls] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(names.map((n) => [n, n in initial && initial[n] === null])),
  );

  const submit = () =>
    onSubmit(Object.fromEntries(names.map((n) => [n, nulls[n] ? null : values[n]])));

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-label={t("Parámetros")}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2>{t("Parámetros")}</h2>
        <p className="muted">
          {t("La consulta usa parámetros con nombre. Cada valor se envía como texto literal escapado; PostgreSQL lo convierte al tipo de la columna.")}
        </p>
        <div className="param-grid">
          {names.map((name, i) => (
            <div key={name} className="param-row">
              <label htmlFor={`param-${name}`}>:{name}</label>
              <input
                id={`param-${name}`}
                autoFocus={i === 0}
                value={nulls[name] ? "" : values[name]}
                placeholder={nulls[name] ? "NULL" : ""}
                disabled={nulls[name]}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              />
              <label className="inline-check" title="Enviar NULL">
                <input
                  type="checkbox"
                  checked={nulls[name]}
                  onChange={(e) => setNulls((n) => ({ ...n, [name]: e.target.checked }))}
                />
                NULL
              </label>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>
            {t("Cancelar")}
          </button>
          <button type="submit" className="primary">
            {t("Ejecutar")}
          </button>
        </div>
      </form>
    </div>
  );
}
