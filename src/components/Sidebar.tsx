import { useEffect, useState } from "react";
import logo from "../assets/hyrax-64.png";
import {
  api,
  errorText,
  profileOfSession,
  sessionKey,
  type ColumnInfo,
  type ConnectionProfile,
  type ObjectKind,
  type RelationInfo,
  type RelationKind,
  type SchemaInfo,
  type SessionInfo,
} from "../api";
import Icon, { type IconName } from "./Icon";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { ActionButton, Row } from "./TreeRow";
import MongoNode from "./MongoNode";
import DropDialog, { type DropRequest } from "./DropDialog";
import CreateDatabaseDialog, { type CreateDatabaseRequest } from "./CreateDatabaseDialog";
import { copyText } from "../clipboard";
import { t } from "../i18n";
import { databaseOfSession } from "../api";

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

const NOUN: Record<RelationKind, string> = {
  table: "la tabla",
  view: "la vista",
  matview: "la vista materializada",
  foreign: "la tabla foránea",
};

const DROP_LABEL: Record<RelationKind, string> = {
  table: "Eliminar tabla…",
  view: "Eliminar vista…",
  matview: "Eliminar vista materializada…",
  foreign: "Eliminar tabla foránea…",
};

const KEYWORD: Record<RelationKind, string> = {
  table: "TABLE",
  view: "VIEW",
  matview: "MATERIALIZED VIEW",
  foreign: "FOREIGN TABLE",
};

type DropTarget =
  | { type: "object"; connId: string; schema: string; name: string; kind: RelationKind }
  | { type: "database"; profile: ConnectionProfile; database: string };

interface Props {
  profiles: ConnectionProfile[];
  connected: Record<string, SessionInfo>;
  selectedConn: string | null;
  theme: "auto" | "light" | "dark";
  onCycleTheme: () => void;
  onSettings: () => void;
  onSelectConn: (id: string) => void;
  onConnect: (profileId: string, database: string, key: string) => Promise<boolean>;
  onDisconnect: (profileId: string) => void;
  /** Vuelve a abrir las sesiones con las credenciales guardadas; devuelve false si falló. */
  onReconnect: (profileId: string) => Promise<boolean>;
  onNew: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onOpenSql: (connId: string, sql?: string) => void;
  onOpenTable: (connId: string, schema: string, table: string) => void;
  onOpenDdl: (connId: string, schema: string, name: string, kind: ObjectKind) => void;
  onSetReadOnly: (key: string, enabled: boolean, confirm?: string) => Promise<void>;
  onObjectDropped: (connId: string, schema: string, name: string) => void;
  onDatabaseDropped: (profileId: string, database: string) => void;
  /** La pantalla de inicio pide abrir una conexión (n cambia en cada petición). */
  openRequest?: { id: string; n: number } | null;
  /** Conexiones de MongoDB con la sesión abierta (por id de conexión). */
  mongoConnected?: Record<string, boolean>;
  onMongoConnect: (profileId: string) => Promise<boolean>;
  onOpenCollection: (profileId: string, database: string, collection: string, kind: "collection" | "view" | "timeseries") => void;
}

interface ConnCache {
  schemas?: SchemaInfo[];
  relations: Record<string, RelationInfo[]>;
  columns: Record<string, ColumnInfo[]>;
  error?: string;
}

const GROUPS: { kind: RelationKind; label: string; icon: IconName }[] = [
  { kind: "table", label: "Tablas", icon: "table" },
  { kind: "view", label: "Vistas", icon: "view" },
  { kind: "matview", label: "Vistas materializadas", icon: "matview" },
  { kind: "foreign", label: "Tablas foráneas", icon: "foreign" },
];

const key = (...parts: string[]) => JSON.stringify(parts);

export default function Sidebar(props: Props) {
  const { profiles, connected, selectedConn } = props;
  const [cache, setCache] = useState<Record<string, ConnCache>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  const [dbErrors, setDbErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [creating, setCreating] = useState<ConnectionProfile | null>(null);

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const dropRequest = (target: DropTarget): { request: DropRequest; unlockKey: string | null } => {
    if (target.type === "object") {
      const production = profiles.find((p) => p.id === profileOfSession(target.connId))?.production ?? false;
      return {
        unlockKey: target.connId,
        request: {
          noun: t(NOUN[target.kind]),
          name: target.name,
          display: `${target.schema}.${target.name}`,
          sql: (cascade) =>
            `DROP ${KEYWORD[target.kind]} ${quoteIdent(target.schema)}.${quoteIdent(target.name)}${cascade ? " CASCADE" : ""}`,
          option: {
            label: t("CASCADE: eliminar también lo que dependa de ella"),
            help: t("Vistas, claves foráneas de otras tablas, etc. Sin esto, si algo depende de ella, la operación falla y no se borra nada."),
          },
          readOnly: connected[target.connId]?.readOnly ?? true,
          unlock: { database: databaseOfSession(target.connId), production },
        },
      };
    }
    const sessions = Object.entries(connected).filter(([k]) => profileOfSession(k) === target.profile.id);
    const first = sessions[0];
    return {
      unlockKey: first ? first[0] : null,
      request: {
        noun: t("la base de datos"),
        name: target.database,
        display: target.database,
        sql: (force) => `DROP DATABASE ${quoteIdent(target.database)}${force ? " WITH (FORCE)" : ""}`,
        option: {
          label: t("Forzar: desconectar a quien esté usando la base"),
          help: t("Cierra a la fuerza las demás conexiones a esa base (PostgreSQL 13 o superior). Sin esto, si alguien la usa, la operación falla."),
        },
        readOnly: !sessions.some(([, info]) => !info.readOnly),
        unlock: first ? { database: databaseOfSession(first[0]), production: target.profile.production } : undefined,
        lockedHint: t("Conéctate a alguna base de este servidor para poder habilitar la escritura."),
      },
    };
  };

  const createRequest = (profile: ConnectionProfile): { request: CreateDatabaseRequest; unlockKey: string | null } => {
    const sessions = Object.entries(connected).filter(([k]) => profileOfSession(k) === profile.id);
    const first = sessions[0];
    return {
      unlockKey: first ? first[0] : null,
      request: {
        server: profile.name,
        existing: databases[profile.id] ?? [],
        readOnly: !sessions.some(([, info]) => !info.readOnly),
        unlock: first ? { database: databaseOfSession(first[0]), production: profile.production } : undefined,
        lockedHint: t("Conéctate a alguna base de este servidor para poder habilitar la escritura."),
      },
    };
  };

  const confirmCreate = async (profile: ConnectionProfile, name: string) => {
    await api.createDatabase(profile.id, name);
    setCreating(null);
    const live = Object.keys(connected).find((s) => profileOfSession(s) === profile.id);
    if (live) await loadDatabases(profile, live);
  };

  const confirmDrop = async (target: DropTarget, option: boolean, typed: string) => {
    if (target.type === "object") {
      await api.dropObject(target.connId, target.schema, target.name, target.kind, option, typed);
      setDrop(null);
      setCache((prev) => {
        const current = prev[target.connId];
        if (!current) return prev;
        const columns = { ...current.columns };
        delete columns[JSON.stringify([target.schema, target.name])];
        return { ...prev, [target.connId]: { ...current, columns } };
      });
      await loadRelations(target.connId, target.schema);
      props.onObjectDropped(target.connId, target.schema, target.name);
      return;
    }
    await api.dropDatabase(target.profile.id, target.database, option, typed);
    setDrop(null);
    const session = sessionKey(target.profile.id, target.database);
    setCache((prev) => {
      const next = { ...prev };
      delete next[session];
      return next;
    });
    setDatabases((prev) => ({
      ...prev,
      [target.profile.id]: (prev[target.profile.id] ?? []).filter((d) => d !== target.database),
    }));
    props.onDatabaseDropped(target.profile.id, target.database);
  };

  const withBusy = async (id: string, work: () => Promise<void>) => {
    if (busy.has(id)) return;
    setBusy((prev) => new Set(prev).add(id));
    try {
      await work();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const hasSession = (profileId: string) =>
    Object.keys(connected).some((k) => profileOfSession(k) === profileId);

  const patch = (id: string, fn: (c: ConnCache) => ConnCache) =>
    setCache((prev) => ({ ...prev, [id]: fn(prev[id] ?? { relations: {}, columns: {} }) }));

  const toggle = (k: string, on?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = on ?? !next.has(k);
      if (want) next.add(k);
      else next.delete(k);
      return next;
    });

  useEffect(() => {
    setDatabases((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([pid]) => hasSession(pid)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setCache((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!(id in connected)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setExpanded((prev) => {
      const next = new Set(
        [...prev].filter((k) => {
          const id = (JSON.parse(k) as string[])[1];
          return id in connected || hasSession(id);
        }),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [connected]);

  const loadRelations = async (id: string, schema: string) => {
    try {
      const rels = await api.listRelations(id, schema);
      patch(id, (c) => ({ ...c, error: undefined, relations: { ...c.relations, [schema]: rels } }));
    } catch (e) {
      patch(id, (c) => ({ ...c, error: errorText(e) }));
    }
  };

  const loadSchemas = async (id: string) => {
    try {
      const schemas = await api.listSchemas(id);
      patch(id, (c) => ({ ...c, error: undefined, schemas, relations: {}, columns: {} }));
      if (schemas.some((s) => s.name === "public")) {
        toggle(key("schema", id, "public"), true);
        await loadRelations(id, "public");
      }
    } catch (e) {
      patch(id, (c) => ({ ...c, error: errorText(e) }));
    }
  };

  const loadDatabases = async (profile: ConnectionProfile, session: string) => {
    try {
      const names = await api.listDatabases(session);
      setDatabases((prev) => ({ ...prev, [profile.id]: names }));
      setDbErrors((prev) => {
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
    } catch (e) {
      setDbErrors((prev) => ({ ...prev, [profile.id]: errorText(e) }));
    }
  };

  const clickConnection = (profile: ConnectionProfile) =>
    withBusy(profile.id, async () => {
      const initial = sessionKey(profile.id, profile.database);
      props.onSelectConn(initial);
      const k = key("conn", profile.id);
      const live = Object.keys(connected).find((s) => profileOfSession(s) === profile.id);
      if (live) {
        if (databases[profile.id]) {
          toggle(k);
          return;
        }
        toggle(k, true);
        await loadDatabases(profile, live);
        if (live in connected && !cache[live]?.schemas) await loadSchemas(live);
        return;
      }
      if (await props.onConnect(profile.id, profile.database, initial)) {
        toggle(k, true);
        toggle(key("db", profile.id, profile.database), true);
        await loadDatabases(profile, initial);
        await loadSchemas(initial);
      }
    });

  const openRequestN = props.openRequest?.n;
  useEffect(() => {
    const request = props.openRequest;
    if (!request) return;
    const profile = props.profiles.find((p) => p.id === request.id);
    // Las conexiones de MongoDB atienden la petición en su propio nodo.
    if (profile && profile.engine !== "mongodb") void clickConnection(profile);
    // Solo debe reaccionar a una petición nueva, no a cada cambio de perfiles o sesiones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequestN]);

  const clickDatabase = (profile: ConnectionProfile, database: string) => {
    const session = sessionKey(profile.id, database);
    return withBusy(session, async () => {
      props.onSelectConn(session);
      const k = key("db", profile.id, database);
      if (session in connected) {
        toggle(k);
        return;
      }
      if (await props.onConnect(profile.id, database, session)) {
        toggle(k, true);
        await loadSchemas(session);
      }
    });
  };

  const clickSchema = async (id: string, schema: string) => {
    const k = key("schema", id, schema);
    const opening = !expanded.has(k);
    toggle(k, opening);
    if (opening && !cache[id]?.relations[schema]) await loadRelations(id, schema);
  };

  const clickTable = async (id: string, schema: string, table: string) => {
    const k = key("table", id, schema, table);
    const opening = !expanded.has(k);
    toggle(k, opening);
    const ck = key(schema, table);
    if (opening && !cache[id]?.columns[ck]) {
      try {
        const cols = await api.listColumns(id, schema, table);
        patch(id, (c) => ({ ...c, columns: { ...c.columns, [ck]: cols } }));
      } catch (e) {
        patch(id, (c) => ({ ...c, error: errorText(e) }));
      }
    }
  };

  const toggleGroup = (k: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });

  const needle = filter.trim().toLowerCase();

  const renderSchema = (id: string, schema: SchemaInfo) => {
    const sk = key("schema", id, schema.name);
    const open = expanded.has(sk);
    const loaded = cache[id]?.relations[schema.name];
    const relations = (loaded ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
    return (
      <div key={sk}>
        <Row
          depth={2}
          label={schema.name}
          icon="folder"
          iconClass="ic-schema"
          expandable
          expanded={open}
          muted={schema.isSystem}
          onClick={() => clickSchema(id, schema.name)}
          actions={<ActionButton title={t("Refrescar schema")} icon="refresh" onClick={() => loadRelations(id, schema.name)} />}
        />
        {open && loaded === undefined && <Row depth={3} label={t("Cargando…")} muted />}
        {open &&
          GROUPS.map((g) => {
            const items = relations.filter((r) => r.kind === g.kind);
            if (items.length === 0) return null;
            const gk = key("group", id, schema.name, g.kind);
            const groupOpen = !collapsedGroups.has(gk) || needle.length > 0;
            return (
              <div key={gk}>
                <Row
                  depth={3}
                  label={`${t(g.label)} (${items.length})`}
                  expandable
                  expanded={groupOpen}
                  onClick={() => toggleGroup(gk)}
                />
                {groupOpen && items.map((r) => renderRelation(id, schema.name, r, g.icon))}
              </div>
            );
          })}
        {open && relations.length === 0 && loaded !== undefined && (
          <Row depth={3} label={needle ? t("Sin coincidencias") : t("Vacío")} muted />
        )}
      </div>
    );
  };

  const renderRelation = (id: string, schema: string, rel: RelationInfo, icon: IconName) => {
    const tk = key("table", id, schema, rel.name);
    const open = expanded.has(tk);
    const columns = cache[id]?.columns[key(schema, rel.name)];
    return (
      <div key={tk}>
        <Row
          depth={4}
          label={rel.name}
          icon={icon}
          iconClass={"ic-" + rel.kind}
          expandable
          expanded={open}
          title={t("Doble clic para abrir los datos · clic derecho para más acciones")}
          onClick={() => clickTable(id, schema, rel.name)}
          onDoubleClick={() => props.onOpenTable(id, schema, rel.name)}
          onContextMenu={(e) =>
            openMenu(e, [
              { key: "open", label: t("Abrir datos"), icon: <Icon name="open" size={13} />, onClick: () => props.onOpenTable(id, schema, rel.name) },
              { key: "ddl", label: t("Ver DDL"), icon: <Icon name="code" size={13} />, onClick: () => props.onOpenDdl(id, schema, rel.name, rel.kind) },
              {
                key: "select",
                label: t("Nueva consulta SELECT"),
                icon: <Icon name="terminal" size={13} />,
                onClick: () =>
                  props.onOpenSql(id, `SELECT *\nFROM ${quoteIdent(schema)}.${quoteIdent(rel.name)}\nLIMIT 100;`),
              },
              { key: "copy", label: t("Copiar nombre"), icon: <Icon name="copy" size={13} />, onClick: () => void copyText(`${schema}.${rel.name}`) },
              { key: "sep", label: "", separator: true },
              {
                key: "drop",
                label: t(DROP_LABEL[rel.kind]),
                icon: <Icon name="trash" size={13} />,
                danger: true,
                onClick: () => setDrop({ type: "object", connId: id, schema, name: rel.name, kind: rel.kind }),
              },
            ])
          }
          actions={
            <>
              <ActionButton title={t("Ver DDL")} icon="code" onClick={() => props.onOpenDdl(id, schema, rel.name, rel.kind)} />
              <ActionButton title={t("Abrir datos")} icon="open" onClick={() => props.onOpenTable(id, schema, rel.name)} />
            </>
          }
        />
        {open && !columns && <Row depth={5} label={t("Cargando…")} muted />}
        {open &&
          columns?.map((c) => (
            <Row
              key={c.name}
              depth={5}
              label={`${c.name}  ${c.dataType}`}
              icon={c.isPrimaryKey ? "key" : "column"}
              iconClass={c.isPrimaryKey ? "ic-pk" : "ic-col"}
              muted={c.nullable && !c.isPrimaryKey}
              title={c.nullable ? "Admite NULL" : "NOT NULL"}
            />
          ))}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="" />
          <strong>Hyrax</strong>
        </div>
        <span className="spacer" />
        <button
          className="ghost icon-btn"
          title={t("Tema: {name}", { name: props.theme === "auto" ? t("automático") : props.theme === "dark" ? t("oscuro") : t("claro") })}
          onClick={props.onCycleTheme}
        >
          {props.theme === "auto" ? <span className="theme-auto">A</span> : <Icon name={props.theme === "dark" ? "moon" : "sun"} size={14} />}
        </button>
        <button className="ghost icon-btn" title={t("Nueva conexión")} onClick={props.onNew}>
          <Icon name="plus" size={15} />
        </button>
        <button className="ghost icon-btn" title={t("Ajustes")} aria-label={t("Ajustes")} onClick={props.onSettings}>
          <Icon name="settings" size={15} />
        </button>
      </div>
      <div className="search">
        <Icon name="search" size={13} />
        <input placeholder={t("Filtrar tablas…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="tree">
        {profiles.length === 0 && (
          <div className="empty-hint">
            <Icon name="server" size={28} />
            <p>{t("Aún no hay conexiones")}</p>
            <button className="primary" onClick={props.onNew}>
              {t("Crear una")}
            </button>
          </div>
        )}
        {profiles.map((profile) => {
          if (profile.engine === "mongodb") {
            return (
              <MongoNode
                key={profile.id}
                profile={profile}
                connected={!!props.mongoConnected?.[profile.id]}
                onConnect={props.onMongoConnect}
                onDisconnect={props.onDisconnect}
                onReconnect={props.onReconnect}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
                onOpenCollection={props.onOpenCollection}
                openRequestN={props.openRequest?.id === profile.id ? props.openRequest.n : undefined}
              />
            );
          }
          const id = profile.id;
          const isConnected = hasSession(id);
          const initial = sessionKey(id, profile.database);
          const open = isConnected && expanded.has(key("conn", id));
          const names = databases[id];
          const rootError = dbErrors[id] ?? cache[initial]?.error;
          const firstSession = Object.keys(connected).find((k) => profileOfSession(k) === id);
          const sqlSession =
            selectedConn && profileOfSession(selectedConn) === id && selectedConn in connected
              ? selectedConn
              : (firstSession ?? initial);
          return (
            <div key={id}>
              <Row
                depth={0}
                label={busy.has(id) ? t("{name} — conectando…", { name: profile.name }) : profile.name}
                icon="server"
                iconClass={isConnected ? "ic-on" : "ic-off"}
                tag={profile.production ? { text: "PROD", tone: "danger" } : undefined}
                expandable={isConnected}
                expanded={open}
                title={`${profile.host}:${profile.port}`}
                onClick={() => clickConnection(profile)}
                onContextMenu={
                  isConnected
                    ? (e) =>
                        openMenu(e, [
                          { key: "sql", label: t("Nuevo editor SQL"), icon: <Icon name="terminal" size={13} />, onClick: () => props.onOpenSql(sqlSession) },
                          { key: "create", label: t("Crear base de datos…"), icon: <Icon name="plus" size={13} />, onClick: () => setCreating(profile) },
                          { key: "sep", label: "", separator: true },
                          {
                            key: "reload",
                            label: t("Recargar bases de datos"),
                            icon: <Icon name="refresh" size={13} />,
                            onClick: () => firstSession && void loadDatabases(profile, firstSession),
                          },
                          {
                            key: "reconnect",
                            label: t("Reconectar (usa las credenciales guardadas)"),
                            icon: <Icon name="plug" size={13} />,
                            onClick: () =>
                              void withBusy(id, async () => {
                                if ((await props.onReconnect(id)) && firstSession) await loadDatabases(profile, firstSession);
                              }),
                          },
                        ])
                    : undefined
                }
                actions={
                  <>
                    {isConnected && (
                      <>
                        <ActionButton title={t("Nuevo editor SQL")} icon="terminal" onClick={() => props.onOpenSql(sqlSession)} />
                        <ActionButton
                          title={t("Recargar bases de datos")}
                          icon="refresh"
                          onClick={() => firstSession && loadDatabases(profile, firstSession)}
                        />
                        <ActionButton
                          title={t("Reconectar (usa las credenciales guardadas)")}
                          icon="plug"
                          onClick={() =>
                            withBusy(id, async () => {
                              if ((await props.onReconnect(id)) && firstSession) await loadDatabases(profile, firstSession);
                            })
                          }
                        />
                        <ActionButton title={t("Desconectar")} icon="power" onClick={() => props.onDisconnect(id)} />
                      </>
                    )}
                    <ActionButton title={t("Editar")} icon="edit" onClick={() => props.onEdit(profile)} />
                    <ActionButton title={t("Eliminar")} icon="trash" danger onClick={() => props.onDelete(profile)} />
                  </>
                }
              />
              {open && rootError && <div className="tree-error">{rootError}</div>}
              {open && !names && !rootError && <Row depth={1} label={t("Cargando…")} muted />}
              {open &&
                names?.map((database) => {
                  const session = sessionKey(id, database);
                  const info = connected[session];
                  const dbOpen = !!info && expanded.has(key("db", id, database));
                  const c = cache[session];
                  return (
                    <div key={session}>
                      <Row
                        depth={1}
                        label={busy.has(session) ? t("{name} — conectando…", { name: database }) : database}
                        icon="database"
                        iconClass={info ? "ic-db" : "ic-off"}
                        tag={info ? (info.readOnly ? { text: t("solo lectura"), tone: "ok" } : { text: t("escritura"), tone: "warn" }) : undefined}
                        expandable
                        expanded={dbOpen}
                        active={selectedConn === session}
                        muted={!info}
                        title={info ? info.version : t("Clic para conectar")}
                        onClick={() => clickDatabase(profile, database)}
                        onContextMenu={(e) =>
                          openMenu(e, [
                            ...(info
                              ? [
                                  { key: "sql", label: t("Nuevo editor SQL"), icon: <Icon name="terminal" size={13} />, onClick: () => props.onOpenSql(session) },
                                  { key: "reload", label: t("Recargar schemas"), icon: <Icon name="refresh" size={13} />, onClick: () => void loadSchemas(session) },
                                ]
                              : []),
                            { key: "copy", label: t("Copiar nombre"), icon: <Icon name="copy" size={13} />, onClick: () => void copyText(database) },
                            { key: "create", label: t("Crear base de datos…"), icon: <Icon name="plus" size={13} />, onClick: () => setCreating(profile) },
                            { key: "sep", label: "", separator: true },
                            {
                              key: "drop",
                              label: t("Eliminar base de datos…"),
                              icon: <Icon name="trash" size={13} />,
                              danger: true,
                              onClick: () => setDrop({ type: "database", profile, database }),
                            },
                          ])
                        }
                        actions={
                          info ? (
                            <>
                              <ActionButton title={t("Nuevo editor SQL")} icon="terminal" onClick={() => props.onOpenSql(session)} />
                              <ActionButton title={t("Recargar schemas")} icon="refresh" onClick={() => loadSchemas(session)} />
                            </>
                          ) : undefined
                        }
                      />
                      {dbOpen && c?.error && <div className="tree-error">{c.error}</div>}
                      {dbOpen && !c?.schemas && !c?.error && <Row depth={2} label={t("Cargando…")} muted />}
                      {dbOpen && c?.schemas?.map((s) => renderSchema(session, s))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {drop &&
        (() => {
          const { request, unlockKey } = dropRequest(drop);
          return (
            <DropDialog
              request={request}
              onEnableWrite={async (confirm) => {
                if (unlockKey) await props.onSetReadOnly(unlockKey, false, confirm);
              }}
              onConfirm={(option, typed) => confirmDrop(drop, option, typed)}
              onClose={() => setDrop(null)}
            />
          );
        })()}
      {creating &&
        (() => {
          const { request, unlockKey } = createRequest(creating);
          return (
            <CreateDatabaseDialog
              request={request}
              onEnableWrite={async (confirm) => {
                if (unlockKey) await props.onSetReadOnly(unlockKey, false, confirm);
              }}
              onCreate={(name) => confirmCreate(creating, name)}
              onClose={() => setCreating(null)}
            />
          );
        })()}
    </aside>
  );
}
