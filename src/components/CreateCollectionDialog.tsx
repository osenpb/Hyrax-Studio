import { useState } from "react";
import { errorText } from "../api";
import Icon from "./Icon";
import { t } from "../i18n";

export interface CreateCollectionRequest {
  server: string;
  database: string;
  /** Colecciones que ya existen en la base (para avisar de un nombre repetido). */
  existing: string[];
  production: boolean;
}

interface Props {
  request: CreateCollectionRequest;
  onCreate: (name: string, confirm: string) => Promise<void>;
  onClose: () => void;
}

export default function CreateCollectionDialog({ request, onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exists = request.existing.includes(name);
  const padded = name !== name.trim();
  const reserved = name.startsWith("system.");
  const invalid = name.includes("$") || name.includes("\0") || name.length > 255;
  const confirmed = !request.production || typed === request.database;
  const canCreate = name !== "" && !padded && !reserved && !invalid && !exists && confirmed && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, request.production ? typed : "");
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
        aria-label={t("Crear colección")}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) void run();
        }}
      >
        <h2>
          {t("Crear colección")} <code>{request.database}</code>
        </h2>

        <label>
          <span>{t("Nombre de la colección")}</span>
          <input
            autoFocus
            aria-label={t("Nombre de la nueva colección")}
            value={name}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {exists && <div className="muted">{t("Ya existe una colección con ese nombre.")}</div>}
        {padded && <div className="muted">{t("El nombre no puede empezar ni terminar con espacios.")}</div>}
        {reserved && <div className="muted">{t("El prefijo «system.» está reservado para MongoDB.")}</div>}
        {invalid && <div className="muted">{t("El nombre de la colección no es válido.")}</div>}

        <div>
          <div className="muted drop-label">{t("Se ejecutará:")}</div>
          <pre className="sql-preview">db.createCollection({JSON.stringify(name || "…")})</pre>
        </div>

        {request.production && (
          <div className="alert alert-warn drop-lock">
            <Icon name="lock" size={15} />
            <div>
              <div>{t("Conexión de producción: escribe el nombre de la base para confirmar.")}</div>
              <input
                aria-label={t("Nombre de la base {name}", { name: request.database })}
                placeholder={t("Producción: escribe {name}", { name: request.database })}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
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
