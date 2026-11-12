import { useState } from "react";
import { errorText } from "../api";
import Icon from "./Icon";
import { t } from "../i18n";

export interface CreateDatabaseRequest {
  /** Nombre de la conexión, para el título. */
  server: string;
  /** Bases que ya existen en el servidor (para avisar de un nombre repetido). */
  existing: string[];
  /** Ninguna sesión de este servidor tiene la escritura habilitada. */
  readOnly: boolean;
  /** Sesión que se puede desbloquear desde aquí, con la base cuyo nombre exige la producción. */
  unlock?: { database: string; production: boolean };
  /** Mensaje cuando no hay forma de habilitar la escritura desde aquí. */
  lockedHint?: string;
}

interface Props {
  request: CreateDatabaseRequest;
  onEnableWrite: (confirm?: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export default function CreateDatabaseDialog({ request, onEnableWrite, onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockTyped, setUnlockTyped] = useState("");

  const bytes = new TextEncoder().encode(name).length;
  const exists = request.existing.includes(name);
  const valid = name.trim() !== "" && name === name.trim() && bytes <= 63 && !name.includes("\0");
  const canCreate = valid && !exists && !request.readOnly && !busy;

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
        aria-label={t("Crear base de datos")}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) void run(() => onCreate(name));
        }}
      >
        <h2>
          {t("Crear base de datos")} <code>{request.server}</code>
        </h2>

        <label>
          <span>{t("Nombre de la base de datos")}</span>
          <input
            autoFocus
            aria-label={t("Nombre de la nueva base")}
            value={name}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {exists && <div className="muted">{t("Ya existe una base con ese nombre.")}</div>}
        {name !== "" && name !== name.trim() && (
          <div className="muted">{t("El nombre no puede empezar ni terminar con espacios.")}</div>
        )}
        {bytes > 63 && <div className="muted">{t("PostgreSQL admite como máximo 63 bytes en el nombre.")}</div>}

        <div>
          <div className="muted drop-label">{t("Se ejecutará:")}</div>
          <pre className="sql-preview">CREATE DATABASE {quoteIdent(name || "…")};</pre>
        </div>

        {request.readOnly && (
          <div className="alert alert-warn drop-lock">
            <Icon name="lock" size={15} />
            <div>
              <div>{t("La escritura está deshabilitada. Habilítala para poder crear.")}</div>
              {request.unlock ? (
                <div className="drop-unlock">
                  {request.unlock.production && (
                    <input
                      aria-label={t("Nombre de la base {name}", { name: request.unlock.database })}
                      placeholder={t("Producción: escribe {name}", { name: request.unlock.database })}
                      value={unlockTyped}
                      onChange={(e) => setUnlockTyped(e.target.value)}
                    />
                  )}
                  <button
                    type="button"
                    disabled={busy || (request.unlock.production && unlockTyped !== request.unlock.database)}
                    onClick={() => void run(() => onEnableWrite(request.unlock!.production ? unlockTyped : undefined))}
                  >
                    {t("Habilitar escritura")}
                  </button>
                </div>
              ) : (
                request.lockedHint && <div className="muted">{request.lockedHint}</div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-error">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("Cancelar")}
          </button>
          <button type="submit" className="primary" disabled={!canCreate}>
            {busy ? t("Creando…") : t("Crear")}
          </button>
        </div>
      </form>
    </div>
  );
}
