import { useEffect, useRef, useState } from "react";
import { api, errorText, type ObjectKind } from "../api";
import { copyText } from "../clipboard";
import SqlEditor, { type SqlEditorHandle } from "./SqlEditor";
import Icon from "./Icon";
import { t } from "../i18n";

interface Props {
  connId: string;
  schema: string;
  name: string;
  kind: ObjectKind;
  oid: number | null;
  onOpenInSql: (sql: string) => void;
}

export default function DdlView({ connId, schema, name, kind, oid, onOpenInSql }: Props) {
  const editor = useRef<SqlEditorHandle>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .objectDdl(connId, schema, name, kind, oid)
      .then((ddl) => {
        if (cancelled) return;
        setText(ddl);
        editor.current?.setText(ddl);
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [connId, schema, name, kind, oid, reload]);

  const copy = async () => {
    if (text === null) return;
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="ddl-view">
      <div className="toolbar wrap">
        <span className="chip chip-plain">
          <Icon name="code" size={13} /> DDL de {schema}.{name}
        </span>
        <span className="spacer" />
        <button onClick={() => void copy()} disabled={text === null}>
          <Icon name="copy" size={12} /> {copied ? t("Copiado") : t("Copiar")}
        </button>
        <button onClick={() => text !== null && onOpenInSql(text)} disabled={text === null}>
          <Icon name="terminal" size={12} /> {t("Abrir en editor SQL")}
        </button>
        <button onClick={() => setReload((r) => r + 1)}>
          <Icon name="refresh" size={12} /> {t("Refrescar")}
        </button>
      </div>
      {error && (
        <div className="alert alert-error">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}
      {text === null && !error && <div className="grid-empty">{t("Cargando…")}</div>}
      <div className="ddl-editor" hidden={text === null}>
        <SqlEditor ref={editor} initialValue="" readOnly fill onRun={() => undefined} onFormat={() => undefined} />
      </div>
    </div>
  );
}
