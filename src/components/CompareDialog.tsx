import { useMemo, useState } from "react";
import type { ResultSet } from "../api";
import { diffResults, type DiffKind } from "../compare";
import Icon from "./Icon";
import { t } from "../i18n";

export interface Pin {
  id: number;
  label: string;
  result: ResultSet;
  at: number;
}

interface Props {
  pins: Pin[];
  onRemove: (id: number) => void;
  onClose: () => void;
}

const SHOW_LIMIT = 2000;

const LABEL: Record<DiffKind, string> = {
  added: "añadidas",
  removed: "eliminadas",
  changed: "modificadas",
  same: "iguales",
};

export default function CompareDialog({ pins, onRemove, onClose }: Props) {
  const [aId, setAId] = useState<number | null>(pins[0]?.id ?? null);
  const [bId, setBId] = useState<number | null>(pins[1]?.id ?? pins[0]?.id ?? null);
  const [keys, setKeys] = useState<string[]>([]);
  const [show, setShow] = useState<Record<DiffKind, boolean>>({ added: true, removed: true, changed: true, same: false });

  const a = pins.find((p) => p.id === aId) ?? null;
  const b = pins.find((p) => p.id === bId) ?? null;

  const common = useMemo(
    () => (a && b ? a.result.columns.filter((c) => b.result.columns.includes(c)) : []),
    [a, b],
  );
  const activeKeys = keys.filter((k) => common.includes(k));

  const diff = useMemo(
    () => (a && b ? diffResults(a.result, b.result, activeKeys) : null),
    [a, b, activeKeys.join("\u0000")],
  );
  const visible = diff ? diff.rows.filter((r) => show[r.kind]) : [];
  const partial = (a?.result.truncated || b?.result.truncated) ?? false;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal compare-dialog" role="dialog" aria-label={t("Comparar resultados")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="rowform-head">
          <h2>{t("Comparar resultados")}</h2>
          <span className="spacer" />
          <button className="ghost icon-btn" onClick={onClose} title={t("Cerrar")}>
            <Icon name="close" size={14} />
          </button>
        </div>

        {pins.length < 2 && (
          <p className="muted">
            Fija al menos dos resultados con «Fijar resultado» (en el editor SQL) o «Fijar» (en una tabla) y vuelve aquí.
            {pins.length === 1 && " Ya hay uno fijado."}
          </p>
        )}

        {pins.length > 0 && (
          <div className="compare-pickers">
            {(
              [
                [t("A (referencia)"), aId, setAId],
                [t("B (nuevo)"), bId, setBId],
              ] as const
            ).map(([label, value, set]) => (
              <label key={label} className="inline-select">
                {label}
                <select aria-label={label} value={value ?? ""} onChange={(e) => set(Number(e.target.value))}>
                  {pins.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.result.rows.length.toLocaleString()} {t("filas")})
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        {a && b && (
          <>
            <div className="compare-keys">
              <span className="muted">{t("Columnas clave (para emparejar filas; sin clave se comparan filas completas):")}</span>
              {common.map((c) => (
                <label key={c} className="inline-check">
                  <input
                    type="checkbox"
                    checked={activeKeys.includes(c)}
                    onChange={(e) => setKeys((k) => (e.target.checked ? [...k, c] : k.filter((x) => x !== c)))}
                  />
                  {c}
                </label>
              ))}
              {common.length === 0 && <span className="alert-inline">{t("Los dos resultados no tienen columnas en común.")}</span>}
            </div>

            {partial && (
              <div className="alert alert-warn">
                <Icon name="alert" size={15} />
                <span>{t("Alguno de los resultados está truncado: la comparación solo cubre las filas que se cargaron.")}</span>
              </div>
            )}
            {diff && (diff.onlyInA.length > 0 || diff.onlyInB.length > 0) && (
              <div className="alert alert-warn">
                <Icon name="alert" size={15} />
                <span>
                  {t("Columnas que no se comparan:")}{" "}
                  {[...diff.onlyInA.map((c) => `${c} (${t("solo A")})`), ...diff.onlyInB.map((c) => `${c} (${t("solo B")})`)].join(", ")}
                </span>
              </div>
            )}
            {diff && diff.duplicateKeys > 0 && (
              <div className="alert alert-warn">
                <Icon name="alert" size={15} />
                <span>
                  {t("Hay {n} claves repetidas: la clave elegida no identifica cada fila de forma única y el resultado puede ser engañoso.", {
                    n: diff.duplicateKeys,
                  })}
                </span>
              </div>
            )}

            {diff && (
              <>
                <div className="compare-summary">
                  {(Object.keys(LABEL) as DiffKind[]).map((kind) => (
                    <label key={kind} className={"diff-chip diff-" + kind}>
                      <input
                        type="checkbox"
                        checked={show[kind]}
                        onChange={(e) => setShow((s) => ({ ...s, [kind]: e.target.checked }))}
                      />
                      {diff.counts[kind].toLocaleString()} {t(LABEL[kind])}
                    </label>
                  ))}
                </div>
                <div className="compare-table grid-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th className="rownum" />
                        {diff.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.slice(0, SHOW_LIMIT).map((row, r) => {
                        const cells = row.b ?? row.a ?? [];
                        return (
                          <tr key={r} className={"diff-row diff-" + row.kind}>
                            <td className="rownum">{{ added: "+", removed: "−", changed: "≠", same: "=" }[row.kind]}</td>
                            {cells.map((value, i) => {
                              const before = row.a?.[i] ?? null;
                              const differs = row.kind === "changed" && row.changed.has(i);
                              return (
                                <td key={i} className={differs ? "diff-cell" : value === null ? "null" : ""}>
                                  {differs ? (
                                    <>
                                      <span className="diff-old">{before === null ? "NULL" : before}</span>
                                      {" → "}
                                      <span className="diff-new">{value === null ? "NULL" : value}</span>
                                    </>
                                  ) : value === null ? (
                                    "NULL"
                                  ) : (
                                    value
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {visible.length === 0 && <div className="grid-empty">{t("No hay filas con los filtros elegidos.")}</div>}
                  {visible.length > SHOW_LIMIT && (
                    <div className="grid-empty">{t("Se muestran las primeras {n} de {total} filas.", { n: SHOW_LIMIT.toLocaleString(), total: visible.length.toLocaleString() })}</div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {pins.length > 0 && (
          <div className="compare-pins">
            <span className="muted">{t("Resultados fijados:")}</span>
            {pins.map((p) => (
              <span key={p.id} className="pin-chip">
                {p.label}
                <button className="ghost icon-btn" title={t("Quitar")} onClick={() => onRemove(p.id)}>
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
