import type { ForeignKey, TableStructure } from "../api";
import { bytes, count } from "../format";
import Icon from "./Icon";

interface Props {
  structure: TableStructure | null;
  error: string | null;
  onOpenTable: (schema: string, table: string) => void;
}

const cols = (names: string[]) => names.join(", ");

function FkTable({
  fks,
  incoming,
  onOpenTable,
}: {
  fks: ForeignKey[];
  incoming: boolean;
  onOpenTable: (schema: string, table: string) => void;
}) {
  return (
    <table className="grid struct-table">
      <thead>
        <tr>
          <th>Nombre</th>
          <th>{incoming ? "Tabla que referencia" : "Columnas"}</th>
          <th>{incoming ? "Columnas referenciadas aquí" : "Referencia a"}</th>
          <th>Al actualizar</th>
          <th>Al eliminar</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {fks.map((fk) => {
          const target = incoming
            ? { schema: fk.schema, table: fk.table }
            : { schema: fk.refSchema, table: fk.refTable };
          return (
            <tr key={`${fk.schema}.${fk.table}.${fk.name}`}>
              <td>{fk.name}</td>
              <td>{incoming ? `${fk.schema}.${fk.table} (${cols(fk.columns)})` : cols(fk.columns)}</td>
              <td>
                {incoming
                  ? cols(fk.refColumns)
                  : `${fk.refSchema}.${fk.refTable} (${cols(fk.refColumns)})`}
              </td>
              <td>{fk.onUpdate}</td>
              <td className={fk.onDelete === "CASCADE" ? "cascade" : ""}>{fk.onDelete}</td>
              <td>
                <button
                  className="small"
                  title={`Abrir ${target.schema}.${target.table}`}
                  onClick={() => onOpenTable(target.schema, target.table)}
                >
                  <Icon name="open" size={11} /> Abrir
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function StructureView({ structure, error, onOpenTable }: Props) {
  if (error) {
    return (
      <div className="alert alert-error">
        <Icon name="alert" size={15} />
        <span>{error}</span>
      </div>
    );
  }
  if (!structure) return <div className="grid-empty">Cargando estructura…</div>;
  const fkColumns = new Set(structure.foreignKeys.flatMap((fk) => fk.columns));
  const plainConstraints = structure.constraints.filter((c) => c.kind !== "foreign");
  const s = structure.stats;

  return (
    <div className="structure">
      {structure.comment && <p className="struct-comment">{structure.comment}</p>}

      <section>
        <h3>Columnas ({structure.columns.length})</h3>
        <table className="grid struct-table">
          <thead>
            <tr>
              <th className="rownum">#</th>
              <th>Columna</th>
              <th>Tipo</th>
              <th>Nulo</th>
              <th>Por defecto</th>
              <th>PK</th>
              <th>FK</th>
              <th>Comentario</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((c, i) => (
              <tr key={c.name}>
                <td className="rownum">{i + 1}</td>
                <td>{c.name}</td>
                <td>
                  {c.dataType}
                  {c.identity && <span className="tag tag-ok">identity {c.identity.toLowerCase()}</span>}
                  {c.generated && <span className="tag tag-ok">generada</span>}
                </td>
                <td>{c.nullable ? "sí" : "no"}</td>
                <td className={c.default === null ? "null" : ""}>{c.default ?? "—"}</td>
                <td>{c.isPrimaryKey ? <Icon name="key" className="ic-pk" /> : ""}</td>
                <td>{fkColumns.has(c.name) ? <Icon name="foreign" className="ic-fk" /> : ""}</td>
                <td className={c.comment ? "" : "null"}>{c.comment ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Claves foráneas ({structure.foreignKeys.length})</h3>
        {structure.foreignKeys.length === 0 ? (
          <p className="muted struct-none">Esta tabla no referencia a otras.</p>
        ) : (
          <FkTable fks={structure.foreignKeys} incoming={false} onOpenTable={onOpenTable} />
        )}
      </section>

      <section>
        <h3>Referenciada por ({structure.referencedBy.length})</h3>
        {structure.referencedBy.length === 0 ? (
          <p className="muted struct-none">Ninguna otra tabla la referencia.</p>
        ) : (
          <FkTable fks={structure.referencedBy} incoming onOpenTable={onOpenTable} />
        )}
      </section>

      <section>
        <h3>Índices ({structure.indexes.length})</h3>
        {structure.indexes.length === 0 ? (
          <p className="muted struct-none">Sin índices.</p>
        ) : (
          <table className="grid struct-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Definición</th>
                <th>Tipo</th>
                <th>Tamaño</th>
              </tr>
            </thead>
            <tbody>
              {structure.indexes.map((i) => (
                <tr key={i.name}>
                  <td>{i.name}</td>
                  <td className="wrap-cell">{i.definition}</td>
                  <td>
                    {i.primary ? "primaria" : i.unique ? "única" : "normal"}
                    {!i.valid && <span className="tag tag-danger">inválido</span>}
                  </td>
                  <td>{bytes(i.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Restricciones ({plainConstraints.length})</h3>
        {plainConstraints.length === 0 ? (
          <p className="muted struct-none">Sin restricciones de clave, unicidad ni CHECK.</p>
        ) : (
          <table className="grid struct-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Definición</th>
              </tr>
            </thead>
            <tbody>
              {plainConstraints.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>
                    {c.kind}
                    {!c.validated && <span className="tag tag-warn">sin validar</span>}
                  </td>
                  <td className="wrap-cell">{c.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Triggers ({structure.triggers.length})</h3>
        {structure.triggers.length === 0 ? (
          <p className="muted struct-none">Sin triggers.</p>
        ) : (
          <table className="grid struct-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Definición</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {structure.triggers.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td className="wrap-cell">{t.definition}</td>
                  <td>{t.enabled ? "activo" : "desactivado"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Estadísticas</h3>
        <dl className="stats">
          <dt>Filas (estimado)</dt>
          <dd>{count(s.estimatedRows)}</dd>
          <dt>Tamaño total</dt>
          <dd>{bytes(s.totalBytes)}</dd>
          <dt>Datos / índices</dt>
          <dd>
            {bytes(s.tableBytes)} / {bytes(s.indexBytes)}
          </dd>
          <dt>Filas muertas</dt>
          <dd>{count(s.deadTuples)}</dd>
          <dt>Último vacuum</dt>
          <dd>{s.lastVacuum ?? "nunca"}</dd>
          <dt>Último analyze</dt>
          <dd>{s.lastAnalyze ?? "nunca"}</dd>
          <dt>Lecturas secuenciales / por índice</dt>
          <dd>
            {count(s.seqScans)} / {count(s.idxScans)}
          </dd>
        </dl>
      </section>
    </div>
  );
}
