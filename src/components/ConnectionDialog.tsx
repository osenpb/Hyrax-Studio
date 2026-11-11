import { useState } from "react";
import { api, errorText, noMongo, noSsh, type ConnectionProfile, type Engine } from "../api";
import { detectEngine, parseConnectionString, parseMongoUri } from "../connstring";

interface Props {
  initial: ConnectionProfile | null;
  /** Motor preseleccionado al crear una conexión nueva (por omisión PostgreSQL). */
  initialEngine?: Engine;
  onSave: (profile: ConnectionProfile) => Promise<void>;
  onClose: () => void;
}

function blank(engine: Engine = "postgres"): ConnectionProfile {
  const mongo = engine === "mongodb";
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "localhost",
    port: mongo ? 27017 : 5432,
    database: mongo ? "" : "postgres",
    user: mongo ? "" : "postgres",
    password: "",
    sslMode: "disable",
    readOnly: true,
    production: false,
    caCertPath: null,
    hasPassword: false,
    ssh: noSsh(),
    engine,
    mongo: noMongo(),
  };
}

export default function ConnectionDialog({ initial, initialEngine, onSave, onClose }: Props) {
  const [p, setP] = useState<ConnectionProfile>(
    initial
      ? {
          ...initial,
          password: "",
          ssh: { ...(initial.ssh ?? noSsh()), secret: "" },
          engine: initial.engine ?? "postgres",
          mongo: initial.mongo ?? noMongo(),
        }
      : blank(initialEngine),
  );
  const [unknownKey, setUnknownKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    setP((prev) => ({ ...prev, [key]: value }));

  const mongo = p.engine === "mongodb";

  const chooseEngine = (engine: Engine) => {
    if (initial || engine === p.engine) return;
    setMessage(null);
    setUnknownKey(null);
    setP((prev) =>
      engine === "mongodb"
        ? { ...prev, engine, port: 27017, database: "", user: "", sslMode: "disable", ssh: noSsh(), mongo: noMongo() }
        : { ...prev, engine, port: 5432, database: "postgres", user: "postgres", sslMode: "disable", mongo: noMongo() },
    );
  };

  const [raw, setRaw] = useState("");
  const applyString = (text: string) => {
    setRaw("");
    if (!text.trim()) return;
    try {
      const engine = detectEngine(text);
      if (engine && initial && engine !== p.engine) {
        throw new Error(`Esta conexión es de ${p.engine === "mongodb" ? "MongoDB" : "PostgreSQL"}; la cadena es de otro motor.`);
      }
      const done = (hasPassword: boolean, notes: string[]) =>
        setMessage({
          ok: true,
          text: ["Cadena aplicada." + (hasPassword ? " La contraseña se guardará en el almacén del sistema." : ""), ...notes].join(" "),
        });
      if (engine === "mongodb") {
        const { fields, mongo: settings, notes } = parseMongoUri(text);
        setP((prev) => ({
          ...prev,
          ...fields,
          engine: "mongodb",
          mongo: settings,
          ssh: noSsh(),
          database: fields.database ?? "",
          user: fields.user ?? "",
          port: fields.port ?? prev.port,
        }));
        done(!!fields.password, notes);
      } else {
        const { fields, notes } = parseConnectionString(text);
        setP((prev) => ({ ...prev, ...fields, engine: "postgres" }));
        done(!!fields.password, notes);
      }
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  };

  const portOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const valid = mongo
    ? !!p.host.trim() && (p.mongo.srv || portOk(p.port))
    : p.host.trim() &&
      p.database.trim() &&
      p.user.trim() &&
      portOk(p.port) &&
      (!p.ssh.enabled || (p.ssh.host.trim() && p.ssh.user.trim() && portOk(p.ssh.port)));
  // Para guardar hace falta haber confiado en la huella del servidor SSH (se obtiene con «Probar»).
  const canSave = valid && (mongo || !p.ssh.enabled || !!p.ssh.fingerprint);
  const finalName =
    p.name.trim() || (mongo ? `${p.user ? p.user + "@" : ""}${p.host}` : `${p.user}@${p.host}/${p.database}`);
  const setMongo = <K extends keyof ConnectionProfile["mongo"]>(key: K, value: ConnectionProfile["mongo"][K]) =>
    setP((prev) => {
      const next = { ...prev, mongo: { ...prev.mongo, [key]: value } };
      // Atlas (mongodb+srv) exige TLS: se propone verificarlo, sin pisar una elección ya hecha.
      if (key === "srv" && value === true) {
        next.mongo.extraHosts = "";
        next.mongo.directConnection = false;
        if (prev.sslMode === "disable") next.sslMode = "verify";
      }
      return next;
    });

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
        {!initial && (
          <div className="engine-pick" role="radiogroup" aria-label="Motor">
            {(["postgres", "mongodb"] as const).map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={p.engine === e}
                className={p.engine === e ? "active" : ""}
                onClick={() => chooseEngine(e)}
              >
                {e === "postgres" ? "PostgreSQL" : "MongoDB"}
              </button>
            ))}
          </div>
        )}
        <label>
          Cadena de conexión (opcional)
          <input
            autoComplete="off"
            spellCheck={false}
            placeholder={
              mongo
                ? "mongodb+srv://usuario:clave@cluster0.abcde.mongodb.net/base"
                : "postgresql://usuario:clave@host:5432/base?sslmode=verify-full"
            }
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
        {mongo && (
          <label className="check">
            <input type="checkbox" checked={p.mongo.srv} onChange={(e) => setMongo("srv", e.target.checked)} />
            <span>
              <strong>Usar mongodb+srv (Atlas)</strong>
              <small>El host es el nombre DNS del cluster; los nodos y el puerto salen del registro DNS. Exige TLS.</small>
            </span>
          </label>
        )}
        <div className="row">
          <label className="grow">
            {mongo && p.mongo.srv ? "Host (nombre DNS del cluster)" : "Host"}
            <input value={p.host} onChange={(e) => set("host", e.target.value)} />
          </label>
          {!(mongo && p.mongo.srv) && (
            <label className="port">
              Puerto
              <input type="number" value={p.port} onChange={(e) => set("port", Number(e.target.value))} />
            </label>
          )}
        </div>
        {mongo && !p.mongo.srv && (
          <label>
            Otros nodos del conjunto de réplicas (opcional, separados por comas)
            <input
              value={p.mongo.extraHosts}
              placeholder="host2:27017, host3:27017"
              onChange={(e) => setMongo("extraHosts", e.target.value)}
            />
          </label>
        )}
        <label>
          {mongo ? "Base de datos (opcional)" : "Base de datos"}
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
          {mongo ? "TLS" : "SSL"}
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
        {mongo && (
          <div className="row">
            <label className="grow">
              Base de autenticación
              <input
                value={p.mongo.authSource ?? ""}
                placeholder="admin"
                onChange={(e) => setMongo("authSource", e.target.value.trim() === "" ? null : e.target.value)}
              />
            </label>
            <label className="grow">
              Conjunto de réplicas (opcional)
              <input
                value={p.mongo.replicaSet ?? ""}
                onChange={(e) => setMongo("replicaSet", e.target.value.trim() === "" ? null : e.target.value)}
              />
            </label>
          </div>
        )}
        {mongo && !p.mongo.srv && (
          <label className="check">
            <input
              type="checkbox"
              checked={p.mongo.directConnection}
              onChange={(e) => setMongo("directConnection", e.target.checked)}
            />
            <span>
              <strong>Conexión directa a este nodo</strong>
              <small>No descubre el resto del conjunto de réplicas. Útil si solo se llega a ese nodo.</small>
            </span>
          </label>
        )}
        {!mongo && sshBlock}
        <label className="check">
          <input type="checkbox" checked={p.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
          <span>
            <strong>Abrir en modo solo lectura</strong>
            <small>
              {mongo
                ? "Hyrax no lanzará operaciones de escritura. Es un guardarraíl: MongoDB no tiene solo lectura por sesión, así que la protección real es usar un usuario con el rol read."
                : "Postgres rechaza INSERT, UPDATE, DELETE y DDL en la sesión. Puedes habilitar escritura después desde el editor SQL."}
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
