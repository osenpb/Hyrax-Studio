import { useState } from "react";
import Icon from "./Icon";

interface Props {
  readOnly: boolean;
  production: boolean;
  database: string;
  onSet: (readOnly: boolean) => Promise<void>;
  onError?: (message: string) => void;
}

export default function ModeChip({ readOnly, production, database, onSet, onError }: Props) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      await onSet(next);
      setAsking(false);
      setTyped("");
    } catch (e) {
      onError?.(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmed = !production || typed === database;

  return (
    <>
      <button
        className={"chip " + (readOnly ? "chip-ok" : "chip-warn")}
        onClick={() => (readOnly ? setAsking(true) : void change(true))}
        disabled={busy}
        title={readOnly ? "Clic para habilitar escritura" : "Clic para volver a solo lectura"}
      >
        <Icon name={readOnly ? "lock" : "unlock"} size={13} />
        {readOnly ? "Solo lectura" : "Escritura habilitada"}
      </button>
      {production && <span className="chip chip-prod">PRODUCCIÓN</span>}

      {asking && (
        <div className="modal-backdrop" onMouseDown={() => setAsking(false)}>
          <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Habilitar escritura</h2>
            <p>
              Vas a permitir escrituras en <strong>{database}</strong>. Los cambios se confirman al instante y no se
              pueden deshacer. Volverá a solo lectura sola tras 10 minutos.
            </p>
            {production && (
              <>
                <div className="alert alert-error">
                  <Icon name="alert" size={15} />
                  <span>Esta es una conexión de PRODUCCIÓN.</span>
                </div>
                <label>
                  Escribe el nombre de la base de datos (<strong>{database}</strong>) para confirmar
                  <input
                    autoFocus
                    aria-label="Nombre de la base para confirmar"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setAsking(false)}>Cancelar</button>
              <button className="danger" disabled={!confirmed || busy} onClick={() => void change(false)}>
                Habilitar escritura
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
