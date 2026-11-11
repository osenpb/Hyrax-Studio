import type { ConnectionProfile, Engine } from "../api";
import { recentIds, sortByRecent } from "../recent";
import Icon from "./Icon";

interface Props {
  profiles: ConnectionProfile[];
  onNew: (engine: Engine) => void;
  onOpen: (profile: ConnectionProfile) => void;
  logo: string;
}

const ENGINE_LABEL: Record<Engine, string> = { postgres: "PostgreSQL", mongodb: "MongoDB" };

/** Pantalla de inicio: una lista simple y rápida, sin tarjetas pesadas ni imágenes por conexión. */
export default function StartScreen({ profiles, onNew, onOpen, logo }: Props) {
  const ordered = sortByRecent(profiles, recentIds());
  return (
    <div className="start">
      <div className="start-head">
        <img className="start-logo" src={logo} alt="" />
        <div>
          <h1>Hyrax Studio</h1>
          <p>Cliente de bases de datos de escritorio</p>
        </div>
      </div>

      <div className="start-new">
        <button className="primary" onClick={() => onNew("postgres")}>
          <Icon name="plus" size={13} /> Nueva conexión PostgreSQL
        </button>
        <button onClick={() => onNew("mongodb")}>
          <Icon name="plus" size={13} /> Nueva conexión MongoDB
        </button>
      </div>

      <h2 className="start-title">Conexiones</h2>
      {ordered.length === 0 ? (
        <p className="start-empty">
          Todavía no hay conexiones. Crea una con los botones de arriba; también puedes pegar una cadena
          (<code>postgresql://…</code>, <code>mongodb://…</code> o <code>mongodb+srv://…</code>) en el formulario
          y se detecta el motor.
        </p>
      ) : (
        <ul className="start-list">
          {ordered.map((p) => (
            <li key={p.id}>
              <button
                className="start-item"
                onClick={() => onOpen(p)}
                aria-label={`Conectar con ${p.name}`}
                title={`Conectar con ${p.name}`}
              >
                <span className={"engine-badge engine-" + (p.engine ?? "postgres")}>
                  {ENGINE_LABEL[p.engine ?? "postgres"]}
                </span>
                <span className="start-name">{p.name}</span>
                <span className="start-detail">
                  {p.user ? `${p.user}@` : ""}
                  {p.host}
                </span>
                {p.production && <span className="tag tag-danger">PROD</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="start-hint">
        <Icon name="lock" size={12} /> Las conexiones nuevas abren en modo solo lectura. <kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+
        <kbd>A</kbd> abre los comandos.
      </p>
    </div>
  );
}
