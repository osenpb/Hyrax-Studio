import { useState } from "react";
import { copyText, tryParseJson } from "../clipboard";
import { parsePgArray } from "../pgarray";
import Icon from "./Icon";
import { t } from "../i18n";

type Cell = string | null;

interface Props {
  columns: string[];
  rows: Cell[][];
  index: number;
  rowNumber: number;
  types?: Record<string, string>;
  pkColumns: string[];
  /** Valores pendientes de guardar para esta fila, por nombre de columna. */
  staged: Record<string, Cell>;
  editable: boolean;
  onNavigate: (index: number) => void;
  onStage: (rowIndex: number, colIndex: number, value: Cell) => void;
  onClose: () => void;
}

interface Draft {
  text: string;
  isNull: boolean;
}

function pretty(value: Cell): string {
  if (value === null) return "";
  const parsed = tryParseJson(value);
  return parsed !== undefined ? JSON.stringify(parsed, null, 2) : value;
}

function lineCount(text: string): number {
  return Math.min(12, Math.max(1, text.split("\n").length, Math.ceil(text.length / 90)));
}

function Body(props: Props) {
  const { columns, rows, index, types, pkColumns, staged, editable } = props;
  const row = rows[index];
  const shown = columns.map((c, i): Cell => (c in staged ? staged[c] : row[i]));
  const initial: Draft[] = shown.map((v) => ({ text: pretty(v), isNull: v === null }));
  const [drafts, setDrafts] = useState<Draft[]>(initial);
  const [copied, setCopied] = useState<number | null>(null);

  const dirty = drafts.some((d, i) => d.text !== initial[i].text || d.isNull !== initial[i].isNull);

  const apply = () => {
    drafts.forEach((d, i) => {
      if (d.text === initial[i].text && d.isNull === initial[i].isNull) return;
      props.onStage(index, i, d.isNull ? null : d.text);
    });
    props.onClose();
  };

  return (
    <>
      <div className="rowform-fields">
        {columns.map((name, i) => {
          const type = types?.[name];
          const draft = drafts[i];
          const isPk = pkColumns.includes(name);
          const canEdit = editable && !isPk;
          const jsonLike = /^jsonb?$/i.test(type ?? "") || tryParseJson(draft.isNull ? null : draft.text) !== undefined;
          let jsonError: string | null = null;
          if (jsonLike && !draft.isNull && draft.text.trim() !== "") {
            try {
              JSON.parse(draft.text);
            } catch (e) {
              jsonError = e instanceof Error ? e.message : t("JSON no válido");
            }
          }
          const isArray = /\[\]$/.test(type ?? "");
          const items = isArray && !draft.isNull ? parsePgArray(draft.text) : null;
          return (
            <div key={name} className="rowform-field">
              <label htmlFor={`rowform-${i}`}>
                <span className="rowform-name">{name}</span>
                {isPk && <Icon name="key" size={11} className="ic-pk" />}
                {type && <span className="rowform-type">{type}</span>}
                {draft.isNull && <span className="tag tag-warn">NULL</span>}
                {jsonLike && !draft.isNull && (
                  <span className={"tag " + (jsonError ? "tag-danger" : "tag-ok")} title={jsonError ?? undefined}>
                    {jsonError ? t("JSON no válido") : "JSON"}
                  </span>
                )}
              </label>
              <textarea
                id={`rowform-${i}`}
                spellCheck={false}
                rows={lineCount(draft.text)}
                readOnly={!canEdit}
                value={draft.isNull ? "" : draft.text}
                placeholder={draft.isNull ? "NULL" : ""}
                className={jsonLike ? "mono" : ""}
                onChange={(e) =>
                  setDrafts((all) => all.map((d, j) => (j === i ? { text: e.target.value, isNull: false } : d)))
                }
              />
              {items && items.length > 0 && (
                <div className="rowform-array" title={t("Elementos del arreglo (edita el texto {…} de arriba)")}>
                  {items.map((item, k) => (
                    <span key={k} className={"array-item" + (item === null ? " null" : "")}>
                      {item === null ? "NULL" : item}
                    </span>
                  ))}
                </div>
              )}
              <div className="rowform-actions">
                <button
                  className="small ghost"
                  onClick={() =>
                    void copyText(draft.text).then((ok) => {
                      setCopied(ok ? i : null);
                      setTimeout(() => setCopied(null), 1200);
                    })
                  }
                  disabled={draft.isNull}
                >
                  <Icon name="copy" size={11} /> {copied === i ? t("Copiado") : t("Copiar")}
                </button>
                {canEdit && (
                  <>
                    {jsonLike && !jsonError && !draft.isNull && draft.text.trim() !== "" && (
                      <button
                        className="small ghost"
                        title={t("Compactar el JSON en una sola línea")}
                        onClick={() =>
                          setDrafts((all) =>
                            all.map((d, j) => (j === i ? { ...d, text: JSON.stringify(JSON.parse(d.text)) } : d)),
                          )
                        }
                      >
                        {t("Compactar")}
                      </button>
                    )}
                    <button
                      className="small ghost"
                      onClick={() =>
                        setDrafts((all) => all.map((d, j) => (j === i ? { text: "", isNull: !d.isNull } : d)))
                      }
                    >
                      {draft.isNull ? "Quitar NULL" : "Poner NULL"}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editable && (
        <div className="modal-actions">
          <span className="muted">{t("Los cambios se añaden a los pendientes; no se guarda nada en la base hasta aplicarlos.")}</span>
          <span className="spacer" />
          <button onClick={props.onClose}>{t("Cancelar")}</button>
          <button className="primary" disabled={!dirty} onClick={apply}>
            {t("Añadir a cambios pendientes")}
          </button>
        </div>
      )}
    </>
  );
}

export default function RowForm(props: Props) {
  const { index, rows } = props;
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal rowform" role="dialog" aria-label={t("Fila como formulario")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="rowform-head">
          <h2>Fila {props.rowNumber.toLocaleString()}</h2>
          <button
            className="icon-btn"
            title={t("Fila anterior")}
            disabled={index === 0}
            onClick={() => props.onNavigate(index - 1)}
          >
            <Icon name="prev" size={14} />
          </button>
          <button
            className="icon-btn"
            title={t("Fila siguiente")}
            disabled={index >= rows.length - 1}
            onClick={() => props.onNavigate(index + 1)}
          >
            <Icon name="next" size={14} />
          </button>
          <span className="spacer" />
          <button className="ghost icon-btn" onClick={props.onClose} title={t("Cerrar")}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <Body key={index} {...props} />
      </div>
    </div>
  );
}
