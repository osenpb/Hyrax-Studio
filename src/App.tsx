import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logoLarge from "./assets/hyrax-256.png";
import {
  api,
  databaseOfSession,
  errorText,
  profileOfSession,
  type ColumnFilter,
  type ConnectionProfile,
  type Engine,
  type MongoConnectInfo,
  type ObjectKind,
  type ObjectRef,
  type ResultSet,
  type SessionInfo,
} from "./api";
import Sidebar from "./components/Sidebar";
import ConnectionDialog from "./components/ConnectionDialog";
import TableTab from "./components/TableTab";
import SqlTab from "./components/SqlTab";
import DdlView from "./components/DdlView";
import Palette, { type PaletteItem } from "./components/Palette";
import CompareDialog, { type Pin } from "./components/CompareDialog";
import ResetDialog from "./components/ResetDialog";
import StartScreen from "./components/StartScreen";
import SettingsDialog from "./components/SettingsDialog";
import { t as tr, useLang } from "./i18n";
import MongoCollectionTab from "./components/MongoCollectionTab";
import { markRecent } from "./recent";
import Icon, { type IconName } from "./components/Icon";
import { clearHistory } from "./history";
import { rank } from "./fuzzy";

interface Tab {
  id: string;
  kind: "table" | "sql" | "ddl" | "collection";
  connId: string;
  title: string;
  schema?: string;
  table?: string;
  filters?: ColumnFilter[];
  ddl?: { kind: ObjectKind; oid: number | null };
  initialSql?: string;
  /** Pestañas de colección de MongoDB. */
  database?: string;
  collection?: string;
}

const MAX_PINS = 8;

const KIND_ICON: Record<ObjectKind, IconName> = {
  table: "table",
  view: "view",
  matview: "matview",
  foreign: "foreign",
  sequence: "sequence",
  function: "func",
  procedure: "func",
};

const KIND_LABEL: Record<ObjectKind, string> = {
  table: "tabla",
  view: "vista",
  matview: "vista materializada",
  foreign: "tabla foránea",
  sequence: "secuencia",
  function: "función",
  procedure: "procedimiento",
};

const WRITE_WINDOW_MS = 10 * 60 * 1000;

type Theme = "auto" | "light" | "dark";

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem("hyrax-theme");
    return saved === "light" || saved === "dark" ? saved : "auto";
  } catch {
    return "auto";
  }
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [connected, setConnected] = useState<Record<string, SessionInfo>>({});
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ profile: ConnectionProfile | null; engine?: Engine } | null>(null);
  const [mongoConnected, setMongoConnected] = useState<Record<string, MongoConnectInfo>>({});
  const [openRequest, setOpenRequest] = useState<{ id: string; n: number } | null>(null);
  const [toDelete, setToDelete] = useState<ConnectionProfile | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Al cambiar de idioma se vuelve a dibujar toda la aplicación.
  const lang = useLang();
  const [banner, setBanner] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [palette, setPalette] = useState<"objects" | "commands" | null>(null);
  const [objects, setObjects] = useState<Record<string, ObjectRef[]>>({});
  const [objectsStatus, setObjectsStatus] = useState<string | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sqlCounter = useRef(0);
  const pinCounter = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("hyrax-theme", theme);
    } catch {
      return;
    }
  }, [theme]);

  const sessionTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const reloadProfiles = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
    } catch (e) {
      setBanner(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reloadProfiles();
  }, [reloadProfiles]);

  const isProduction = (key: string) => profiles.find((p) => p.id === profileOfSession(key))?.production ?? false;

  const nameOf = (key: string) => {
    const profile = profiles.find((p) => p.id === profileOfSession(key));
    return profile ? `${profile.name} / ${databaseOfSession(key)}` : key;
  };

  const connect = async (profileId: string, database: string, key: string) => {
    setBanner(null);
    try {
      const info = await api.connect(profileId, database);
      setConnected((prev) => ({ ...prev, [key]: info }));
      markRecent(profileId);
      return true;
    } catch (e) {
      setBanner(tr("No se pudo conectar: {error}", { error: errorText(e) }));
      return false;
    }
  };

  const connectMongo = async (profileId: string) => {
    setBanner(null);
    try {
      const info = await api.mongoConnect(profileId);
      setMongoConnected((prev) => ({ ...prev, [profileId]: info }));
      markRecent(profileId);
      return true;
    } catch (e) {
      setBanner(tr("No se pudo conectar: {error}", { error: errorText(e) }));
      return false;
    }
  };

  const openCollection = (profileId: string, database: string, collection: string) => {
    const id = `m:${profileId}:${database}.${collection}`;
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, kind: "collection", connId: profileId, database, collection, title: collection }],
    );
    setActiveTab(id);
  };

  const changeReadOnly = async (key: string, enabled: boolean, confirm?: string) => {
    const readOnly = await api.setReadOnly(key, enabled, confirm);
    setConnected((prev) => (key in prev ? { ...prev, [key]: { ...prev[key], readOnly } } : prev));
  };

  useEffect(() => {
    const timers = sessionTimers.current;
    for (const key of Object.keys(timers)) {
      if (!(key in connected) || connected[key].readOnly) {
        clearTimeout(timers[key]);
        delete timers[key];
      }
    }
    for (const [key, info] of Object.entries(connected)) {
      if (!info.readOnly && !(key in timers)) {
        timers[key] = setTimeout(() => {
          delete timers[key];
          api
            .setReadOnly(key, true)
            .then((readOnly) => {
              setConnected((prev) => (key in prev ? { ...prev, [key]: { ...prev[key], readOnly } } : prev));
              setBanner(tr("La escritura se desactivó sola tras 10 minutos en {name}. La sesión volvió a solo lectura.", { name: nameOf(key) }));
            })
            .catch(() => undefined);
        }, WRITE_WINDOW_MS);
      }
    }
  }, [connected]);

  const closeTabsOf = (profileId: string) => {
    setTabs((prev) => prev.filter((t) => profileOfSession(t.connId) !== profileId));
    setActiveTab((cur) => {
      const tab = tabs.find((t) => t.id === cur);
      return tab && profileOfSession(tab.connId) === profileId ? null : cur;
    });
  };

  const closeTabsWhere = (predicate: (t: Tab) => boolean) => {
    const closing = new Set(tabs.filter(predicate).map((t) => t.id));
    if (closing.size === 0) return;
    setTabs((prev) => prev.filter((t) => !closing.has(t.id)));
    setActiveTab((cur) => (cur && closing.has(cur) ? null : cur));
  };

  const forgetSessions = (profileId: string) => {
    setConnected((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => profileOfSession(key) !== profileId)),
    );
    setMongoConnected((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== profileId)));
  };

  const disconnect = async (profileId: string) => {
    await api.disconnectProfile(profileId).catch(() => undefined);
    forgetSessions(profileId);
    closeTabsOf(profileId);
  };

  const openTable = (connId: string, schema: string, table: string, filters?: ColumnFilter[]) => {
    const filtered = filters && filters.length > 0 ? filters : undefined;
    const id = `t:${connId}:${schema}.${table}` + (filtered ? `:${JSON.stringify(filtered)}` : "");
    const title = filtered
      ? `${table} · ${filtered.map((f) => `${f.column}=${f.value}`).join(", ")}`.slice(0, 44)
      : table;
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, kind: "table", connId, schema, table, title, filters: filtered }],
    );
    setActiveTab(id);
  };

  const openSql = (connId: string, initialSql?: string) => {
    sqlCounter.current += 1;
    const id = `q:${sqlCounter.current}`;
    setTabs((prev) => [
      ...prev,
      { id, kind: "sql", connId, title: `SQL ${sqlCounter.current}`, initialSql },
    ]);
    setActiveTab(id);
  };

  const openDdl = (connId: string, schema: string, name: string, kind: ObjectKind, oid: number | null = null) => {
    const id = `d:${connId}:${schema}.${name}:${oid ?? ""}`;
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, kind: "ddl", connId, schema, table: name, title: `DDL ${name}`, ddl: { kind, oid } }],
    );
    setActiveTab(id);
  };

  const renameTab = (id: string, title: string) =>
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));

  const pinResult = (label: string, result: ResultSet) => {
    pinCounter.current += 1;
    const pin: Pin = { id: pinCounter.current, label, result, at: Date.now() };
    setPins((prev) => [...prev, pin].slice(-MAX_PINS));
    setNote(tr("Resultado fijado: {label}. Usa «Comparar» para ver las diferencias con otro.", { label }));
  };

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  const closeTab = (id: string) => {
    const index = tabs.findIndex((t) => t.id === id);
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTab === id) setActiveTab(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
  };

  const saveProfile = async (profile: ConnectionProfile) => {
    await api.saveProfile(profile);
    await disconnect(profile.id);
    await reloadProfiles();
    setDialog(null);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    const id = toDelete.id;
    await api.deleteProfile(id).catch((e) => setBanner(errorText(e)));
    clearHistory(id);
    forgetSessions(id);
    closeTabsOf(id);
    setToDelete(null);
    await reloadProfiles();
  };

  // Tras borrar todo lo guardado la app queda como recién instalada.
  const afterReset = async () => {
    setResetOpen(false);
    setTabs([]);
    setActiveTab(null);
    setConnected({});
    setPins([]);
    await reloadProfiles();
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setSidebarWidth(Math.min(600, Math.max(220, ev.clientX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sqlTarget = selectedConn && selectedConn in connected ? selectedConn : (Object.keys(connected)[0] ?? null);

  const cycleTheme = () => setTheme((cur) => (cur === "auto" ? "dark" : cur === "dark" ? "light" : "auto"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        setPalette("objects");
      } else if (key === "a" && e.shiftKey) {
        e.preventDefault();
        setPalette("commands");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (palette !== "objects" || !sqlTarget) return;
    let cancelled = false;
    setObjectsStatus(tr("Cargando objetos…"));
    api
      .searchObjects(sqlTarget)
      .then((list) => {
        if (cancelled) return;
        setObjects((prev) => ({ ...prev, [sqlTarget]: list }));
        setObjectsStatus(null);
      })
      .catch((e) => !cancelled && setObjectsStatus(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [palette, sqlTarget]);

  const objectList = sqlTarget ? (objects[sqlTarget] ?? []) : [];
  const objectByKey = useMemo(() => {
    const map = new Map<string, ObjectRef>();
    for (const o of objectList) map.set(`${o.kind}:${o.schema}.${o.name}:${o.oid}`, o);
    return map;
  }, [objectList]);

  const searchObjects = useCallback(
    (query: string): PaletteItem[] =>
      rank(objectList, query, (o) => [o.name, `${o.schema}.${o.name}`], 60).map((o) => ({
        key: `${o.kind}:${o.schema}.${o.name}:${o.oid}`,
        label: o.kind === "function" || o.kind === "procedure" ? `${o.name}(${o.detail ?? ""})` : o.name,
        detail: `${o.schema} · ${tr(KIND_LABEL[o.kind])}`,
        icon: <Icon name={KIND_ICON[o.kind]} size={14} className={"ic-" + o.kind} />,
      })),
    [objectList, lang],
  );

  const pickObject = (item: PaletteItem, alternate: boolean) => {
    const o = objectByKey.get(item.key);
    if (!o || !sqlTarget) return;
    setPalette(null);
    const openable = o.kind === "table" || o.kind === "view" || o.kind === "matview" || o.kind === "foreign";
    if (openable && !alternate) openTable(sqlTarget, o.schema, o.name);
    else openDdl(sqlTarget, o.schema, o.name, o.kind, o.oid);
  };

  const activeTabInfo = tabs.find((t) => t.id === activeTab) ?? null;

  const commands = useMemo(() => {
    const list: (PaletteItem & { run: () => void })[] = [
      {
        key: "goto",
        label: tr("Ir a tabla, vista o función…"),
        detail: "Ctrl+N",
        icon: <Icon name="search" size={14} />,
        disabled: !sqlTarget,
        run: () => setPalette("objects"),
      },
      {
        key: "sql",
        label: tr("Nuevo editor SQL"),
        detail: sqlTarget ? nameOf(sqlTarget) : tr("conéctate primero"),
        icon: <Icon name="terminal" size={14} />,
        disabled: !sqlTarget,
        run: () => sqlTarget && openSql(sqlTarget),
      },
      {
        key: "compare",
        label: tr("Comparar resultados fijados…"),
        detail: tr("{n} fijados", { n: pins.length }),
        icon: <Icon name="compare" size={14} />,
        run: () => setCompareOpen(true),
      },
      {
        key: "ddl",
        label: tr("Ver DDL de la tabla abierta"),
        detail: activeTabInfo?.kind === "table" ? `${activeTabInfo.schema}.${activeTabInfo.table}` : tr("abre una tabla"),
        icon: <Icon name="code" size={14} />,
        disabled: activeTabInfo?.kind !== "table",
        run: () =>
          activeTabInfo?.kind === "table" &&
          openDdl(activeTabInfo.connId, activeTabInfo.schema!, activeTabInfo.table!, "table"),
      },
      {
        key: "close",
        label: tr("Cerrar la pestaña actual"),
        icon: <Icon name="close" size={14} />,
        disabled: !activeTabInfo,
        run: () => activeTabInfo && closeTab(activeTabInfo.id),
      },
      {
        key: "theme",
        label: tr("Cambiar tema (automático, oscuro, claro)"),
        icon: <Icon name="moon" size={14} />,
        run: cycleTheme,
      },
      {
        key: "new-connection",
        label: tr("Nueva conexión…"),
        icon: <Icon name="plus" size={14} />,
        run: () => setDialog({ profile: null }),
      },
      {
        key: "settings",
        label: tr("Ajustes…"),
        icon: <Icon name="settings" size={14} />,
        run: () => setSettingsOpen(true),
      },
      {
        key: "reset",
        label: tr("Borrar conexiones y contraseñas guardadas…"),
        detail: tr("{n} guardadas", { n: profiles.length }),
        icon: <Icon name="trash" size={14} />,
        run: () => setResetOpen(true),
      },
    ];
    return list;
  }, [sqlTarget, pins.length, activeTabInfo, profiles, tabs, lang]);

  const searchCommands = useCallback(
    (query: string): PaletteItem[] => rank(commands, query, (c) => [c.label], 30),
    [commands],
  );

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <Sidebar
        profiles={profiles}
        connected={connected}
        selectedConn={selectedConn}
        theme={theme}
        onCycleTheme={cycleTheme}
        onSettings={() => setSettingsOpen(true)}
        onSelectConn={setSelectedConn}
        onConnect={connect}
        onDisconnect={disconnect}
        onNew={() => setDialog({ profile: null })}
        openRequest={openRequest}
        mongoConnected={Object.fromEntries(Object.keys(mongoConnected).map((k) => [k, true]))}
        onMongoConnect={connectMongo}
        onOpenCollection={openCollection}
        onEdit={(profile) => setDialog({ profile })}
        onDelete={setToDelete}
        onOpenSql={(connId, sql) => openSql(connId, sql)}
        onSetReadOnly={changeReadOnly}
        onObjectDropped={(connId, schema, name) =>
          closeTabsWhere(
            (t) =>
              t.connId === connId &&
              t.schema === schema &&
              t.table === name &&
              (t.kind === "table" || t.kind === "ddl"),
          )
        }
        onDatabaseDropped={(profileId, database) => {
          const key = `${profileId}::${database}`;
          setConnected((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
          closeTabsWhere((t) => t.connId === key);
          setSelectedConn((cur) => (cur === key ? null : cur));
          setNote(tr("Base de datos {name} eliminada.", { name: database }));
        }}
        onOpenTable={(connId, schema, table) => openTable(connId, schema, table)}
        onOpenDdl={openDdl}
      />
      <div className="resizer" onMouseDown={startResize} />
      <main className="main">
        {note && (
          <div className="alert alert-ok banner">
            <Icon name="pin" size={15} />
            <span>{note}</span>
            <button className="ghost icon-btn" onClick={() => setNote(null)} title={tr("Cerrar")}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {banner && (
          <div className="alert alert-error banner">
            <Icon name="alert" size={15} />
            <span>{banner}</span>
            <button className="ghost icon-btn" onClick={() => setBanner(null)} title={tr("Cerrar")}>
              <Icon name="close" />
            </button>
          </div>
        )}
        <div className="tabbar">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={"tab" + (t.id === activeTab ? " active" : "") + (isProduction(t.connId) ? " prod" : "")}
              onClick={() => setActiveTab(t.id)}
              title={
                t.kind === "collection"
                  ? `${profiles.find((p) => p.id === t.connId)?.name ?? ""} · ${t.database}.${t.collection}`
                  : t.kind === "table"
                    ? `${nameOf(t.connId)} · ${t.schema}.${t.table}`
                    : nameOf(t.connId)
              }
            >
              <Icon
                name={t.kind === "sql" ? "terminal" : t.kind === "ddl" ? "code" : "table"}
                className={t.kind === "sql" ? "ic-sql" : t.kind === "ddl" ? "ic-ddl" : "ic-table"}
              />
              <span className="tab-title">{t.title}</span>
              <button
                className="ghost icon-btn tab-close"
                title={tr("Cerrar pestaña")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          <span className="spacer" />
          {pins.length > 0 && (
            <button className="new-sql" onClick={() => setCompareOpen(true)} title={tr("Comparar resultados fijados")}>
              <Icon name="compare" size={13} /> {tr("Comparar")} ({pins.length})
            </button>
          )}
          <button
            className="new-sql"
            disabled={!sqlTarget}
            onClick={() => sqlTarget && openSql(sqlTarget)}
            title={sqlTarget ? tr("Nuevo editor SQL en {name}", { name: nameOf(sqlTarget) }) : tr("Conéctate primero")}
          >
            <Icon name="plus" size={13} /> SQL
          </button>
        </div>
        <div className="tab-content">
          {tabs.length === 0 && (
            <StartScreen
              profiles={profiles}
              logo={logoLarge}
              onNew={(engine) => setDialog({ profile: null, engine })}
              onOpen={(profile) => setOpenRequest((prev) => ({ id: profile.id, n: (prev?.n ?? 0) + 1 }))}
            />
          )}
          {tabs.map((t) => (
            <div key={t.id} className="tab-pane" hidden={t.id !== activeTab}>
              {t.kind === "collection" ? (
                <MongoCollectionTab
                  profileId={t.connId}
                  database={t.database!}
                  collection={t.collection!}
                  production={isProduction(t.connId)}
                />
              ) : t.kind === "table" ? (
                <TableTab
                  connId={t.connId}
                  schema={t.schema!}
                  table={t.table!}
                  initialFilters={t.filters}
                  readOnly={connected[t.connId]?.readOnly ?? true}
                  production={isProduction(t.connId)}
                  onSetReadOnly={(enabled, confirm) => changeReadOnly(t.connId, enabled, confirm)}
                  onOpenTable={(schema, table, filters) => openTable(t.connId, schema, table, filters)}
                  onOpenInSql={(sql) => openSql(t.connId, sql)}
                  onPin={pinResult}
                />
              ) : t.kind === "ddl" ? (
                <div className={"tab-body" + (isProduction(t.connId) ? " is-prod" : "")}>
                  <DdlView
                    connId={t.connId}
                    schema={t.schema!}
                    name={t.table!}
                    kind={t.ddl!.kind}
                    oid={t.ddl!.oid}
                    onOpenInSql={(sql) => openSql(t.connId, sql)}
                  />
                </div>
              ) : (
                <SqlTab
                  connId={t.connId}
                  connName={nameOf(t.connId)}
                  readOnly={connected[t.connId]?.readOnly ?? true}
                  production={isProduction(t.connId)}
                  initialSql={t.initialSql}
                  onSetReadOnly={(enabled, confirm) => changeReadOnly(t.connId, enabled, confirm)}
                  onTitle={(title) => renameTab(t.id, title)}
                  onPin={pinResult}
                />
              )}
            </div>
          ))}
        </div>
      </main>

      {palette === "objects" && (
        <Palette
          title={tr("Ir a objeto")}
          placeholder={
            sqlTarget
              ? tr("Buscar en {name}: tablas, vistas, funciones…", { name: nameOf(sqlTarget) })
              : tr("Conéctate a una base primero")
          }
          search={searchObjects}
          version={objectList}
          status={
            !sqlTarget
              ? tr("Conéctate a una base de datos para buscar sus objetos.")
              : objectList.length === 0
                ? objectsStatus
                : null
          }
          hint={tr("Enter abre · Ctrl+Enter abre el DDL · Esc cierra")}
          onPick={pickObject}
          onClose={() => setPalette(null)}
        />
      )}
      {palette === "commands" && (
        <Palette
          title={tr("Comandos")}
          placeholder={tr("Escribe un comando…")}
          search={searchCommands}
          version={commands}
          hint={tr("Enter ejecuta · Esc cierra")}
          onPick={(item) => {
            setPalette(null);
            commands.find((c) => c.key === item.key)?.run();
          }}
          onClose={() => setPalette(null)}
        />
      )}
      {compareOpen && (
        <CompareDialog
          pins={pins}
          onRemove={(id) => setPins((prev) => prev.filter((p) => p.id !== id))}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onTheme={setTheme}
          onEraseData={() => {
            setSettingsOpen(false);
            setResetOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {resetOpen && (
        <ResetDialog count={profiles.length} onDone={() => void afterReset()} onClose={() => setResetOpen(false)} />
      )}
      {dialog && (
        <ConnectionDialog
          initial={dialog.profile}
          initialEngine={dialog.engine}
          onSave={saveProfile}
          onClose={() => setDialog(null)}
        />
      )}
      {toDelete && (
        <div className="modal-backdrop" onMouseDown={() => setToDelete(null)}>
          <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{tr("Eliminar conexión")}</h2>
            <p>
              {tr("¿Eliminar")} <strong>{toDelete.name}</strong>{tr("? Solo se borra de Hyrax, no de la base de datos.")}
            </p>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setToDelete(null)}>{tr("Cancelar")}</button>
              <button className="danger" onClick={confirmDelete}>
                {tr("Eliminar")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
