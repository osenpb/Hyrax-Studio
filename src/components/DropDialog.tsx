import { useState } from "react";
import { errorText } from "../api";
import Icon from "./Icon";

export interface DropRequest {
  /** Lo que se va a eliminar, en texto: «la tabla», «la base de datos»… */
  noun: string;
  /** Nombre que hay que escribir para confirmar. */
  name: string;
  /** Texto para mostrar el nombre completo (por ejemplo, schema.tabla). */
  display: string;
  /** SQL que se va a ejecutar, según las opciones elegidas. */
  sql: (option: boolean) => string;
  option?: { label: string; help: string };
  /** La sesión (o el servidor, en el caso de una base) está en solo lectura. */
  readOnly: boolean;
  /** Sesión que se puede desbloquear desde aquí, con la base cuyo nombre exige la producción. */
  unlock?: { database: string; production: boolean };
  /** Mensaje cuando no hay forma de habilitar la escritura desde aquí. */
  lockedHint?: string;
}

interface Props {
  request: DropRequest;
  onEnableWrite: (confirm?: string) => Promise<void>;
  onConfirm: (option: boolean, typed: string) => Promise<void>;
  onClose: () => void;
}

export default function DropDialog({ request, onEnableWrite, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const [option, setOption] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockTyped, setUnlockTyped] = useState("");

  const matches = typed === request.name;
  const locked = request.readOnly;
  const canDrop = matches && !locked && !busy;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal drop-dialog"
        role="dialog"
        aria-label="Confirmar eliminación"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canDrop) void run(() => onConfirm(option, typed));
        }}
      >
        <h2>
          Eliminar {request.noun} <code>{request.display}</code>
        </h2>
        <div className="alert alert-error">
          <Icon name="alert" size={15} />
          <span>
            Esta acción <strong>no se puede deshacer</strong>: se borran {request.noun === "la base de datos" ? "todas sus tablas y datos" : "la definición y todos los datos"}.
            Si no tienes una copia de seguridad, no hay vuelta atrás.
          </span>
        </div>

        {request.option && (
          <label className="check drop-option">
            <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
            <span>
              {request.option.label}
              <small>{request.option.help}</small>
            </span>
          </label>
        )}

        <div>
          <div className="muted drop-label">Se ejecutará:</div>
          <pre className="sql-preview">{request.sql(option)};</pre>
        </div>

        {locked && (
          <div className="alert alert-warn drop-lock">
            <Icon name="lock" size={15} />
            <div>
              <div>La escritura está deshabilitada. Habilítala para poder eliminar.</div>
              {request.unlock ? (
                <div className="drop-unlock">
                  {request.unlock.production && (
                    <input
                      aria-label={`Nombre de la base ${request.unlock.database}`}
                      placeholder={`Producción: escribe ${request.unlock.database}`}
                      value={unlockTyped}
                      onChange={(e) => setUnlockTyped(e.target.value)}
                    />
                  )}
                  <button
                    type="button"
                    disabled={busy || (request.unlock.production && unlockTyped !== request.unlock.database)}
                    onClick={() =>
                      void run(() => onEnableWrite(request.unlock!.production ? unlockTyped : undefined))
                    }
                  >
                    Habilitar escritura
                  </button>
                </div>
              ) : (
                request.lockedHint && <div className="muted">{request.lockedHint}</div>
              )}
            </div>
          </div>
        )}

        <label>
          Escribe <strong>{request.name}</strong> para confirmar
          <input
            autoFocus
            aria-label="Escribe el nombre para confirmar"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>

        {error && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="danger" disabled={!canDrop}>
            {busy ? "Eliminando…" : "Eliminar"}
          </button>
        </div>
      </form>
    </div>
  );
}
