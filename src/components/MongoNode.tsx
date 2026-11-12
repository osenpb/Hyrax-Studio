import { useEffect, useRef, useState } from "react";
import { api, errorText, type ConnectionProfile, type MongoCollection, type MongoDatabase } from "../api";
import { ActionButton, Row } from "./TreeRow";
import { t } from "../i18n";

interface Props {
  profile: ConnectionProfile;
  connected: boolean;
  /** Abre la sesión; devuelve false si falló (el aviso lo muestra quien llama). */
  onConnect: (profileId: string) => Promise<boolean>;
  onDisconnect: (profileId: string) => void;
  /** Abre la sesión de nuevo con las credenciales guardadas; devuelve false si falló. */
  onReconnect: (profileId: string) => Promise<boolean>;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onOpenCollection: (profileId: string, database: string, collection: string, kind: MongoCollection["kind"]) => void;
  /** La pantalla de inicio pide abrir esta conexión (n cambia en cada petición). */
  openRequestN?: number;
}

const SYSTEM_DATABASES = new Set(["admin", "config", "local"]);

function formatSize(bytes: number | null): string | undefined {
  if (bytes === null || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n >= 10 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

/** Una conexión de MongoDB en el árbol: servidor → bases de datos → colecciones. */
export default function MongoNode(props: Props) {
  const { profile, connected } = props;
  const id = profile.id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [databases, setDatabases] = useState<MongoDatabase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDbs, setOpenDbs] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Record<string, MongoCollection[] | { error: string }>>({});

  // admin, config y local son internas de MongoDB: se ocultan salvo que sean lo único que hay.
  const [showSystem, setShowSystem] = useState(false);
  const userDatabases = databases?.filter((d) => !SYSTEM_DATABASES.has(d.name));
  const hideSystem = !showSystem && !!userDatabases && userDatabases.length > 0;
  const visibleDatabases = hideSystem ? userDatabases : databases;
  const hiddenCount =
    userDatabases && userDatabases.length > 0 && databases ? databases.length - userDatabases.length : 0;

  const loadDatabases = async () => {
    setError(null);
    try {
      setDatabases(await api.mongoListDatabases(id));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const loadCollections = async (database: string) => {
    try {
      const list = await api.mongoListCollections(id, database);
      setCollections((prev) => ({ ...prev, [database]: list }));
    } catch (e) {
      setCollections((prev) => ({ ...prev, [database]: { error: errorText(e) } }));
    }
  };

  const clickServer = async () => {
    if (busy) return;
    if (connected) {
      const opening = !open;
      setOpen(opening);
      if (opening && !databases) await loadDatabases();
      return;
    }
    setBusy(true);
    try {
      if (await props.onConnect(id)) {
        setOpen(true);
        await loadDatabases();
      }
    } finally {
      setBusy(false);
    }
  };

  const clickDatabase = async (name: string) => {
    const opening = !openDbs.has(name);
    setOpenDbs((prev) => {
      const next = new Set(prev);
      if (opening) next.add(name);
      else next.delete(name);
      return next;
    });
    if (opening && !collections[name]) await loadCollections(name);
  };

  // Si la sesión se cierra desde fuera (editar o desconectar), el árbol se vacía.
  useEffect(() => {
    if (!connected) {
      setOpen(false);
      setDatabases(null);
      setError(null);
      setOpenDbs(new Set());
      setCollections({});
    }
  }, [connected]);

  // La pantalla de inicio pide abrir la conexión: solo reacciona a una petición nueva.
  const lastRequest = useRef<number | undefined>(props.openRequestN);
  useEffect(() => {
    if (props.openRequestN !== undefined && props.openRequestN !== lastRequest.current) {
      lastRequest.current = props.openRequestN;
      void clickServer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openRequestN]);

  return (
    <div>
      <Row
        depth={0}
        label={busy ? t("{name} — conectando…", { name: profile.name }) : profile.name}
        icon="server"
        iconClass={connected ? "ic-on" : "ic-off"}
        tag={profile.production ? { text: "PROD", tone: "danger" } : undefined}
        expandable={connected}
        expanded={open}
        title={`${profile.host}:${profile.port}`}
        onClick={() => void clickServer()}
        actions={
          <>
            {connected && (
              <>
                <ActionButton title={t("Recargar bases de datos")} icon="refresh" onClick={() => void loadDatabases()} />
                <ActionButton
                  title={t("Reconectar (usa las credenciales guardadas)")}
                  icon="plug"
                  onClick={() => {
                    if (busy) return;
                    setBusy(true);
                    void props
                      .onReconnect(id)
                      .then((ok) => (ok ? loadDatabases() : undefined))
                      .finally(() => setBusy(false));
                  }}
                />
                <ActionButton title={t("Desconectar")} icon="power" onClick={() => props.onDisconnect(id)} />
              </>
            )}
            <ActionButton title={t("Editar")} icon="edit" onClick={() => props.onEdit(profile)} />
            <ActionButton title={t("Eliminar")} icon="trash" danger onClick={() => props.onDelete(profile)} />
          </>
        }
      />
      {open && error && <div className="tree-error">{error}</div>}
      {open && !databases && !error && <Row depth={1} label={t("Cargando…")} muted />}
      {open &&
        visibleDatabases?.map((db) => {
          const dbOpen = openDbs.has(db.name);
          const list = collections[db.name];
          return (
            <div key={db.name}>
              <Row
                depth={1}
                label={db.name}
                icon="database"
                iconClass="ic-db"
                tag={formatSize(db.sizeOnDisk) ? { text: formatSize(db.sizeOnDisk)!, tone: "info" } : undefined}
                expandable
                expanded={dbOpen}
                onClick={() => void clickDatabase(db.name)}
              />
              {dbOpen && !list && <Row depth={2} label={t("Cargando…")} muted />}
              {dbOpen && list && "error" in list && <div className="tree-error">{list.error}</div>}
              {dbOpen && Array.isArray(list) && list.length === 0 && <Row depth={2} label={t("Sin colecciones")} muted />}
              {dbOpen &&
                Array.isArray(list) &&
                list.map((c) => (
                  <Row
                    key={c.name}
                    depth={2}
                    label={c.name}
                    icon={c.kind === "view" ? "view" : "table"}
                    iconClass={c.kind === "view" ? "ic-view" : "ic-table"}
                    title={c.kind === "collection" ? t("Doble clic para ver los documentos") : t("{kind} · doble clic para verlo", { kind: c.kind })}
                    onDoubleClick={() => props.onOpenCollection(id, db.name, c.name, c.kind)}
                    actions={
                      <ActionButton
                        title={t("Ver documentos")}
                        icon="open"
                        onClick={() => props.onOpenCollection(id, db.name, c.name, c.kind)}
                      />
                    }
                  />
                ))}
            </div>
          );
        })}
      {open && hiddenCount > 0 && (
        <Row
          depth={1}
          label={
            showSystem
              ? t("Ocultar bases del sistema")
              : t("Mostrar bases del sistema ({n})", { n: hiddenCount })
          }
          muted
          onClick={() => setShowSystem((v) => !v)}
        />
      )}
    </div>
  );
}
