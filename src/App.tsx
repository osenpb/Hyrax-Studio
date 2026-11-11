import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  databaseOfSession,
  errorText,
  profileOfSession,
  type ConnectionProfile,
  type SessionInfo,
} from "./api";
import Sidebar from "./components/Sidebar";
import ConnectionDialog from "./components/ConnectionDialog";
import TableTab from "./components/TableTab";
import SqlTab from "./components/SqlTab";
import Icon from "./components/Icon";
import { clearHistory } from "./history";

interface Tab {
  id: string;
  kind: "table" | "sql";
  connId: string;
  title: string;
  schema?: string;
  table?: string;
}

const WRITE_WINDOW_MS = 10 * 60 * 1000;

type Theme = "auto" | "light" | "dark";

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem("pgdesk-theme");
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
  const [dialog, setDialog] = useState<{ profile: ConnectionProfile | null } | null>(null);
  const [toDelete, setToDelete] = useState<ConnectionProfile | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const sqlCounter = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("pgdesk-theme", theme);
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
      return true;
    } catch (e) {
      setBanner(`No se pudo conectar: ${errorText(e)}`);
      return false;
    }
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
              setBanner(`La escritura se desactivó sola tras 10 minutos en ${nameOf(key)}. La sesión volvió a solo lectura.`);
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

  const forgetSessions = (profileId: string) =>
    setConnected((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => profileOfSession(key) !== profileId)),
    );

  const disconnect = async (profileId: string) => {
    await api.disconnectProfile(profileId).catch(() => undefined);
    forgetSessions(profileId);
    closeTabsOf(profileId);
  };

  const openTable = (connId: string, schema: string, table: string) => {
    const id = `t:${connId}:${schema}.${table}`;
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, kind: "table", connId, schema, table, title: table }],
    );
    setActiveTab(id);
  };

  const openSql = (connId: string) => {
    sqlCounter.current += 1;
    const id = `q:${sqlCounter.current}`;
    setTabs((prev) => [...prev, { id, kind: "sql", connId, title: `SQL ${sqlCounter.current}` }]);
    setActiveTab(id);
  };

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

  const cycleTheme = () => setTheme((t) => (t === "auto" ? "dark" : t === "dark" ? "light" : "auto"));

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <Sidebar
        profiles={profiles}
        connected={connected}
        selectedConn={selectedConn}
        theme={theme}
        onCycleTheme={cycleTheme}
        onSelectConn={setSelectedConn}
        onConnect={connect}
        onDisconnect={disconnect}
        onNew={() => setDialog({ profile: null })}
        onEdit={(profile) => setDialog({ profile })}
        onDelete={setToDelete}
        onOpenSql={openSql}
        onOpenTable={openTable}
      />
      <div className="resizer" onMouseDown={startResize} />
      <main className="main">
        {banner && (
          <div className="alert alert-error banner">
            <Icon name="alert" size={15} />
            <span>{banner}</span>
            <button className="ghost icon-btn" onClick={() => setBanner(null)} title="Cerrar">
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
              title={t.kind === "table" ? `${nameOf(t.connId)} · ${t.schema}.${t.table}` : nameOf(t.connId)}
            >
              <Icon name={t.kind === "sql" ? "terminal" : "table"} className={t.kind === "sql" ? "ic-sql" : "ic-table"} />
              <span className="tab-title">{t.title}</span>
              <button
                className="ghost icon-btn tab-close"
                title="Cerrar pestaña"
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
          <button
            className="new-sql"
            disabled={!sqlTarget}
            onClick={() => sqlTarget && openSql(sqlTarget)}
            title={sqlTarget ? `Nuevo editor SQL en ${nameOf(sqlTarget)}` : "Conéctate primero"}
          >
            <Icon name="plus" size={13} /> SQL
          </button>
        </div>
        <div className="tab-content">
          {tabs.length === 0 && (
            <div className="welcome">
              <div className="welcome-logo">Pg</div>
              <h1>PgDesk</h1>
              <p>Cliente PostgreSQL de escritorio</p>
              <ul>
                <li>
                  <Icon name="server" /> Conecta un servidor desde el panel izquierdo
                </li>
                <li>
                  <Icon name="database" /> Abre una base de datos para ver sus schemas
                </li>
                <li>
                  <Icon name="table" /> Doble clic en una tabla para ver sus datos
                </li>
                <li>
                  <Icon name="lock" /> Las conexiones nuevas abren en modo solo lectura
                </li>
              </ul>
            </div>
          )}
          {tabs.map((t) => (
            <div key={t.id} className="tab-pane" hidden={t.id !== activeTab}>
              {t.kind === "table" ? (
                <TableTab
                  connId={t.connId}
                  schema={t.schema!}
                  table={t.table!}
                  readOnly={connected[t.connId]?.readOnly ?? true}
                  production={isProduction(t.connId)}
                  onSetReadOnly={(enabled, confirm) => changeReadOnly(t.connId, enabled, confirm)}
                />
              ) : (
                <SqlTab
                  connId={t.connId}
                  connName={nameOf(t.connId)}
                  readOnly={connected[t.connId]?.readOnly ?? true}
                  production={isProduction(t.connId)}
                  onSetReadOnly={(enabled, confirm) => changeReadOnly(t.connId, enabled, confirm)}
                />
              )}
            </div>
          ))}
        </div>
      </main>

      {dialog && (
        <ConnectionDialog initial={dialog.profile} onSave={saveProfile} onClose={() => setDialog(null)} />
      )}
      {toDelete && (
        <div className="modal-backdrop" onMouseDown={() => setToDelete(null)}>
          <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Eliminar conexión</h2>
            <p>
              ¿Eliminar <strong>{toDelete.name}</strong>? Solo se borra de PgDesk, no de la base de datos.
            </p>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setToDelete(null)}>Cancelar</button>
              <button className="danger" onClick={confirmDelete}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
