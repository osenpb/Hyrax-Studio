import { useState } from "react";
import { api, errorText, noSsh, type ConnectionProfile } from "../api";
import { parseConnectionString } from "../connstring";

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
    ssh: noSsh(),
  };
}

export default function ConnectionDialog({ initial, onSave, onClose }: Props) {
  const [p, setP] = useState<ConnectionProfile>(
    initial ? { ...initial, password: "", ssh: { ...(initial.ssh ?? noSsh()), secret: "" } } : blank(),
  );
  const [unknownKey, setUnknownKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    setP((prev) => ({ ...prev, [key]: value }));

  const [raw, setRaw] = useState("");
  const applyString = (text: string) => {
    setRaw("");
    if (!text.trim()) return;
    try {
      const { fields, notes } = parseConnectionString(text);
      setP((prev) => ({ ...prev, ...fields }));
      setMessage({
        ok: true,
        text: ["Cadena aplicada." + (fields.password ? " La contraseña se guardará en el almacén del sistema." : ""), ...notes].join(" "),
      });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  };

  const portOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const valid =
    p.host.trim() &&
    p.database.trim() &&
    p.user.trim() &&
    portOk(p.port) &&
    (!p.ssh.enabled || (p.ssh.host.trim() && p.ssh.user.trim() && portOk(p.ssh.port)));
  // Para guardar hace falta haber confiado en la huella del servidor SSH (se obtiene con «Probar»).
  const canSave = valid && (!p.ssh.enabled || !!p.ssh.fingerprint);
  const finalName = p.name.trim() || `${p.user}@${p.host}/${p.database}`;

  const setSsh = <K extends keyof ConnectionProfile["ssh"]>(key: K, value: ConnectionProfile["ssh"][K]) => {
    const changesServer = key === "host" || key === "port";
    if (changesServer) setUnknownKey(null);
    setP((prev) => {
      const ssh = { ...prev.ssh, [key]: value };
      // Otro servidor SSH no puede heredar la huella de confianza del anterior.
      if (changesServer) ssh.fingerprint = null;
      // Pasar de clave a contraseña (o al revés) cambia el significado del secreto guardado.
      if (key === "keyPath" && (prev.ssh.keyPath === null) !== (value === null) && !ssh.secret) ssh.clearSecret = true;
      if (key === "secret" && value) ssh.clearSecret = false;
      return { ...prev, ssh };
    });
  };

  // El backend responde HYRAX_SSH_UNKNOWN_KEY:<huella> o HYRAX_SSH_CHANGED_KEY:<huella>.
  const explainError = (text: string) => {
    const unknown = text.match(/HYRAX_SSH_UNKNOWN_KEY:(SHA256:\S+)/);
    if (unknown) {
      setUnknownKey(unknown[1]);
      return "El servidor SSH se presenta por primera vez. Comprueba que esta huella es la de tu servidor y confía en ella para continuar.";
    }
    const changed = text.match(/HYRAX_SSH_CHANGED_KEY:(SHA256:\S+)/);
    if (changed) {
      return `¡La clave del servidor SSH cambió! Esperada: ${p.ssh.fingerprint}. Recibida: ${changed[1]}. Puede ser un ataque de intermediario; si el cambio es legítimo, pulsa «Olvidar» y vuelve a confiar.`;
    }
    return text;
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const version = await api.testConnection(p);
      setMessage({ ok: true, text: version });
    } catch (e) {
      setMessage({ ok: false, text: explainError(errorText(e)) });
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

  const sshBlock = (
    <>
      <label className="check">
        <input type="checkbox" checked={p.ssh.enabled} onChange={(e) => setSsh("enabled", e.target.checked)} />
        <span>
          <strong>Conectar por un túnel SSH</strong>
          <small>El servidor de arriba se alcanza desde el servidor SSH (útil si Postgres no es accesible directamente).</small>
        </span>
      </label>
      {p.ssh.enabled && (
        <>
          <div className="row">
            <label className="grow">
              Host SSH
              <input value={p.ssh.host} onChange={(e) => setSsh("host", e.target.value)} />
            </label>
            <label className="port">
              Puerto
              <input type="number" value={p.ssh.port} onChange={(e) => setSsh("port", Number(e.target.value))} />
            </label>
          </div>
          <div className="row">
            <label className="grow">
              Usuario SSH
              <input value={p.ssh.user} onChange={(e) => setSsh("user", e.target.value)} />
            </label>
            <label className="grow">
              {p.ssh.keyPath ? "Frase de la clave" : "Contraseña SSH"}
              <input
                type="password"
                autoComplete="off"
                value={p.ssh.secret}
                placeholder={
                  p.ssh.clearSecret
                    ? "Se olvidará la guardada al guardar"
                    : initial?.ssh?.hasSecret
                      ? "Guardada en el sistema (vacío = conservar)"
                      : ""
                }
                onChange={(e) => setSsh("secret", e.target.value)}
              />
              {initial?.ssh?.hasSecret && !p.ssh.clearSecret && !p.ssh.secret && (
                <button type="button" className="small" onClick={() => setSsh("clearSecret", true)}>
                  Olvidar la guardada
                </button>
              )}
            </label>
          </div>
          <label>
            Clave privada (archivo, opcional; vacío = contraseña)
            <input
              value={p.ssh.keyPath ?? ""}
              placeholder="~/.ssh/id_ed25519 o C:\Users\tu\.ssh\id_ed25519"
              onChange={(e) => setSsh("keyPath", e.target.value.trim() === "" ? null : e.target.value)}
            />
          </label>
          <div className="ssh-fingerprint">
            {p.ssh.fingerprint ? (
              <>
                <span>
                  Huella de confianza: <code>{p.ssh.fingerprint}</code>
                </span>
                <button type="button" className="small" onClick={() => setSsh("fingerprint", null)}>
                  Olvidar
                </button>
              </>
            ) : unknownKey ? (
              <>
                <span>
                  Huella del servidor: <code>{unknownKey}</code>
                </span>
                <button type="button" className="small primary" onClick={() => setSsh("fingerprint", unknownKey)}>
                  Confiar en esta huella
                </button>
              </>
            ) : (
              <span className="muted">Pulsa «Probar» para ver la huella del servidor y confiar en ella.</span>
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? "Editar conexión" : "Nueva conexión"}</h2>
        <label>
          Cadena de conexión (opcional)
          <input
            autoComplete="off"
            spellCheck={false}
            placeholder="postgresql://usuario:clave@host:5432/base?sslmode=verify-full"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              applyString(e.clipboardData.getData("text"));
            }}
            onBlur={() => applyString(raw)}
            onKeyDown={(e) => e.key === "Enter" && applyString(raw)}
          />
        </label>
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
        {sshBlock}
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
          <button className="primary" onClick={save} disabled={!canSave || busy} title={valid && !canSave ? "Pulsa Probar y confía en la huella del servidor SSH" : undefined}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
