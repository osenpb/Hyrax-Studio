import { useState } from "react";
import { api, errorText, type ConnectionProfile } from "../api";

interface Props {
  initial: ConnectionProfile | null;
  onSave: (profile: ConnectionProfile) => Promise<void>;
  onClose: () => void;
}

function blank(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "",
    sslMode: "disable",
    readOnly: true,
    production: false,
    caCertPath: null,
    hasPassword: false,
  };
}

export default function ConnectionDialog({ initial, onSave, onClose }: Props) {
  const [p, setP] = useState<ConnectionProfile>(initial ? { ...initial, password: "" } : blank());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    setP((prev) => ({ ...prev, [key]: value }));

  const valid = p.host.trim() && p.database.trim() && p.user.trim() && p.port > 0;
  const finalName = p.name.trim() || `${p.user}@${p.host}/${p.database}`;

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const version = await api.testConnection(p);
      setMessage({ ok: true, text: version });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ ...p, name: finalName });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? "Editar conexión" : "Nueva conexión"}</h2>
        <label>
          Nombre
          <input value={p.name} placeholder={finalName} onChange={(e) => set("name", e.target.value)} />
        </label>
        <div className="row">
          <label className="grow">
            Host
            <input value={p.host} onChange={(e) => set("host", e.target.value)} />
          </label>
          <label className="port">
            Puerto
            <input
              type="number"
              value={p.port}
              onChange={(e) => set("port", Number(e.target.value))}
            />
          </label>
        </div>
        <label>
          Base de datos
          <input value={p.database} onChange={(e) => set("database", e.target.value)} />
        </label>
        <div className="row">
          <label className="grow">
            Usuario
            <input value={p.user} onChange={(e) => set("user", e.target.value)} />
          </label>
          <label className="grow">
            Contraseña
            <input
              type="password"
              autoComplete="off"
              value={p.password}
              placeholder={initial?.hasPassword ? "Guardada en el sistema (vacío = conservar)" : ""}
              onChange={(e) => set("password", e.target.value)}
            />
          </label>
        </div>
        <label>
          SSL
          <select value={p.sslMode} onChange={(e) => set("sslMode", e.target.value as ConnectionProfile["sslMode"])}>
            <option value="disable">Desactivado</option>
            <option value="require">Cifrado sin verificar el certificado</option>
            <option value="verify">Cifrado y verificar el certificado (recomendado)</option>
          </select>
        </label>
        {p.sslMode === "require" && (
          <div className="alert alert-warn">
            <span>
              Sin verificar el certificado, la conexión va cifrada pero no se comprueba con quién hablas: un
              intermediario podría suplantar al servidor. Úsalo solo en redes de confianza.
            </span>
          </div>
        )}
        {p.sslMode === "verify" && (
          <label>
            Certificado de la CA (archivo PEM, opcional)
            <input
              value={p.caCertPath ?? ""}
              placeholder="Vacío = usar las entidades de confianza del sistema"
              onChange={(e) => set("caCertPath", e.target.value.trim() === "" ? null : e.target.value)}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={p.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
          <span>
            <strong>Abrir en modo solo lectura</strong>
            <small>
              Postgres rechaza INSERT, UPDATE, DELETE y DDL en la sesión. Puedes habilitar escritura después
              desde el editor SQL.
            </small>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.production} onChange={(e) => set("production", e.target.checked)} />
          <span>
            <strong>Marcar como producción</strong>
            <small>
              Resalta la conexión en rojo en toda la interfaz y exige escribir el nombre de la base para habilitar la
              escritura.
            </small>
          </span>
        </label>
        {message && <div className={"alert " + (message.ok ? "alert-ok" : "alert-error")}>{message.text}</div>}
        <div className="modal-actions">
          <button onClick={test} disabled={!valid || busy}>
            Probar
          </button>
          <span className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save} disabled={!valid || busy}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
