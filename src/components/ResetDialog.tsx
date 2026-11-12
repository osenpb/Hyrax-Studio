import { useState } from "react";
import { api, errorText } from "../api";
import { clearAllHistory } from "../history";
import Icon from "./Icon";
import { t } from "../i18n";

/** Palabra que hay que escribir; el backend acepta la de los dos idiomas. */
export const resetWord = () => t("BORRAR");

interface Props {
  /** Cuántas conexiones hay guardadas (solo informativo). */
  count: number;
  onDone: () => void;
  onClose: () => void;
}

export default function ResetDialog({ count, onDone, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = typed === resetWord() && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetAppData(typed);
      if (history) clearAllHistory();
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal drop-dialog" role="dialog" aria-label={t("Borrar datos guardados")} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t("Borrar conexiones y contraseñas guardadas")}</h2>
        <div className="alert alert-error">
          <Icon name="alert" size={14} />
          <span>
            {t("Se eliminan")} <strong>{count}</strong> {count === 1 ? t("conexión") : t("conexiones")}
            {t(", sus contraseñas y las claves SSH guardadas en el almacén de credenciales del sistema. No se puede deshacer.")}
          </span>
        </div>
        <p className="muted">
          {t("Se incluye la copia antigua de PgDesk, si todavía existe. No se toca ninguna base de datos, ni tus archivos, ni el tema. Las sesiones abiertas se cierran. Sirve para dejar Hyrax Studio como recién instalado.")}
        </p>
        <label className="check">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          <span>
            <strong>{t("Borrar también el historial de consultas")}</strong>
            <small>{t("Las consultas que escribiste se guardan en este equipo, en claro.")}</small>
          </span>
        </label>
        <label>
          <span>
            {t("Escribe")} <strong>{resetWord()}</strong> {t("para confirmar")}
          </span>
          <input
            autoFocus
            aria-label={t("Escribe {word} para confirmar", { word: resetWord() })}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ready && void run()}
          />
        </label>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>{t("Cancelar")}</button>
          <button className="danger" disabled={!ready} onClick={() => void run()}>
            {t("Borrar todo")}
          </button>
        </div>
      </div>
    </div>
  );
}
