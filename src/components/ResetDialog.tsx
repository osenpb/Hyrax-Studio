import { useState } from "react";
import { api, errorText } from "../api";
import { clearAllHistory } from "../history";
import Icon from "./Icon";

export const RESET_WORD = "BORRAR";

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

  const ready = typed === RESET_WORD && !busy;

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
      <div className="modal drop-dialog" role="dialog" aria-label="Borrar datos guardados" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Borrar conexiones y contraseñas guardadas</h2>
        <div className="alert alert-error">
          <Icon name="alert" size={14} />
          <span>
            Se eliminan <strong>{count}</strong> {count === 1 ? "conexión" : "conexiones"}, sus contraseñas y las
            claves SSH guardadas en el almacén de credenciales del sistema. No se puede deshacer.
          </span>
        </div>
        <p className="muted">
          Se incluye la copia antigua de PgDesk, si todavía existe. No se toca ninguna base de datos, ni tus archivos,
          ni el tema. Las sesiones abiertas se cierran. Sirve para dejar Hyrax Studio como recién instalado.
        </p>
        <label className="check">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          <span>
            <strong>Borrar también el historial de consultas</strong>
            <small>Las consultas que escribiste se guardan en este equipo, en claro.</small>
          </span>
        </label>
        <label>
          <span>
            Escribe <strong>{RESET_WORD}</strong> para confirmar
          </span>
          <input
            autoFocus
            aria-label="Escribe BORRAR para confirmar"
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
          <button onClick={onClose}>Cancelar</button>
          <button className="danger" disabled={!ready} onClick={() => void run()}>
            Borrar todo
          </button>
        </div>
      </div>
    </div>
  );
}
