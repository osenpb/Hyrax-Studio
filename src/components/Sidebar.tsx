import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  errorText,
  profileOfSession,
  sessionKey,
  type ColumnInfo,
  type ConnectionProfile,
  type RelationInfo,
  type RelationKind,
  type SchemaInfo,
  type SessionInfo,
} from "../api";
import Icon, { type IconName } from "./Icon";

interface Props {
  profiles: ConnectionProfile[];
  connected: Record<string, SessionInfo>;
  selectedConn: string | null;
  theme: "auto" | "light" | "dark";
  onCycleTheme: () => void;
  onSelectConn: (id: string) => void;
  onConnect: (profileId: string, database: string, key: string) => Promise<boolean>;
  onDisconnect: (profileId: string) => void;
  onNew: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onOpenSql: (connId: string) => void;
  onOpenTable: (connId: string, schema: string, table: string) => void;
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

interface RowProps {
  depth: number;
  label: string;
  icon?: IconName;
  iconClass?: string;
  tag?: { text: string; tone: "ok" | "warn" | "danger" };
  expandable?: boolean;
  expanded?: boolean;
  active?: boolean;
  muted?: boolean;
  title?: string;
  actions?: ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

function Row(p: RowProps) {
  return (
    <div
      className={"tree-row" + (p.active ? " active" : "") + (p.muted ? " muted" : "")}
      style={{ paddingLeft: 8 + p.depth * 14 }}
      title={p.title}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
    >
      <span className={"chev" + (p.expanded ? " open" : "") + (p.expandable ? "" : " hidden")}>
        <Icon name="chevron" size={12} />
      </span>
      {p.icon && <Icon name={p.icon} className={p.iconClass} size={14} />}
      <span className="label">{p.label}</span>
      {p.tag && <span className={"tag tag-" + p.tag.tone}>{p.tag.text}</span>}
      {p.actions && (
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {p.actions}
        </span>
      )}
    </div>
  );
}

function ActionButton(props: { title: string; icon: IconName; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={"ghost icon-btn" + (props.danger ? " danger-hover" : "")}
      title={props.title}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={13} />
    </button>
  );
}

export default function Sidebar(props: Props) {
  const { profiles, connected, selectedConn } = props;
  const [cache, setCache] = useState<Record<string, ConnCache>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  const [dbErrors, setDbErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

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
          actions={<ActionButton title="Refrescar schema" icon="refresh" onClick={() => loadRelations(id, schema.name)} />}
        />
        {open && loaded === undefined && <Row depth={3} label="Cargando…" muted />}
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
                  label={`${g.label} (${items.length})`}
                  expandable
                  expanded={groupOpen}
                  onClick={() => toggleGroup(gk)}
                />
                {groupOpen && items.map((r) => renderRelation(id, schema.name, r, g.icon))}
              </div>
            );
          })}
        {open && relations.length === 0 && loaded !== undefined && (
          <Row depth={3} label={needle ? "Sin coincidencias" : "Vacío"} muted />
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
          title="Doble clic para abrir los datos"
          onClick={() => clickTable(id, schema, rel.name)}
          onDoubleClick={() => props.onOpenTable(id, schema, rel.name)}
          actions={<ActionButton title="Abrir datos" icon="open" onClick={() => props.onOpenTable(id, schema, rel.name)} />}
        />
        {open && !columns && <Row depth={5} label="Cargando…" muted />}
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
          <span className="brand-logo">Pg</span>
          <strong>PgDesk</strong>
        </div>
        <span className="spacer" />
        <button
          className="ghost icon-btn"
          title={`Tema: ${props.theme === "auto" ? "automático" : props.theme === "dark" ? "oscuro" : "claro"}`}
          onClick={props.onCycleTheme}
        >
          {props.theme === "auto" ? <span className="theme-auto">A</span> : <Icon name={props.theme === "dark" ? "moon" : "sun"} size={14} />}
        </button>
        <button className="ghost icon-btn" title="Nueva conexión" onClick={props.onNew}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="search">
        <Icon name="search" size={13} />
        <input placeholder="Filtrar tablas…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="tree">
        {profiles.length === 0 && (
          <div className="empty-hint">
            <Icon name="server" size={28} />
            <p>Aún no hay conexiones</p>
            <button className="primary" onClick={props.onNew}>
              Crear una
            </button>
          </div>
        )}
        {profiles.map((profile) => {
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
                label={busy.has(id) ? `${profile.name} — conectando…` : profile.name}
                icon="server"
                iconClass={isConnected ? "ic-on" : "ic-off"}
                tag={profile.production ? { text: "PROD", tone: "danger" } : undefined}
                expandable={isConnected}
                expanded={open}
                title={`${profile.host}:${profile.port}`}
                onClick={() => clickConnection(profile)}
                actions={
                  <>
                    {isConnected && (
                      <>
                        <ActionButton title="Nuevo editor SQL" icon="terminal" onClick={() => props.onOpenSql(sqlSession)} />
                        <ActionButton
                          title="Recargar bases de datos"
                          icon="refresh"
                          onClick={() => firstSession && loadDatabases(profile, firstSession)}
                        />
                        <ActionButton title="Desconectar" icon="power" onClick={() => props.onDisconnect(id)} />
                      </>
                    )}
                    <ActionButton title="Editar" icon="edit" onClick={() => props.onEdit(profile)} />
                    <ActionButton title="Eliminar" icon="trash" danger onClick={() => props.onDelete(profile)} />
                  </>
                }
              />
              {open && rootError && <div className="tree-error">{rootError}</div>}
              {open && !names && !rootError && <Row depth={1} label="Cargando…" muted />}
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
                        label={busy.has(session) ? `${database} — conectando…` : database}
                        icon="database"
                        iconClass={info ? "ic-db" : "ic-off"}
                        tag={info ? (info.readOnly ? { text: "solo lectura", tone: "ok" } : { text: "escritura", tone: "warn" }) : undefined}
                        expandable
                        expanded={dbOpen}
                        active={selectedConn === session}
                        muted={!info}
                        title={info ? info.version : "Clic para conectar"}
                        onClick={() => clickDatabase(profile, database)}
                        actions={
                          info ? (
                            <>
                              <ActionButton title="Nuevo editor SQL" icon="terminal" onClick={() => props.onOpenSql(session)} />
                              <ActionButton title="Recargar schemas" icon="refresh" onClick={() => loadSchemas(session)} />
                            </>
                          ) : undefined
                        }
                      />
                      {dbOpen && c?.error && <div className="tree-error">{c.error}</div>}
                      {dbOpen && !c?.schemas && !c?.error && <Row depth={2} label="Cargando…" muted />}
                      {dbOpen && c?.schemas?.map((s) => renderSchema(session, s))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
