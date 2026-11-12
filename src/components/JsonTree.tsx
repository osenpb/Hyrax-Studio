import { useState } from "react";
import { describe, isContainer, type BsonKind } from "../ejson";
import { t } from "../i18n";
import Icon from "./Icon";

interface Props {
  value: unknown;
  /** Nombre del campo (o índice) que se muestra delante del valor. */
  name?: string;
  /** Niveles que se abren de entrada. */
  openDepth?: number;
  level?: number;
}

/** Etiqueta del tipo BSON, solo en los tipos que el JSON no distingue por sí solo. */
const BADGE: Partial<Record<BsonKind, string>> = {
  Int32: "int",
  Int64: "long",
  Double: "double",
  Decimal128: "decimal",
  ObjectId: "ObjectId",
  Date: "date",
  Binary: "binary",
  Timestamp: "timestamp",
  RegExp: "regex",
  MinKey: "minKey",
  MaxKey: "maxKey",
  Undefined: "undefined",
  Symbol: "symbol",
  Code: "code",
};

const SCALAR_CLASS: Partial<Record<BsonKind, string>> = {
  String: "jt-string",
  Boolean: "jt-bool",
  Null: "jt-null",
  Int32: "jt-num",
  Int64: "jt-num",
  Double: "jt-num",
  Decimal128: "jt-num",
  Number: "jt-num",
};

/** Árbol de un documento de MongoDB en JSON extendido canónico, con el tipo BSON de cada valor. */
export default function JsonTree({ value, name, openDepth = 2, level = 0 }: Props) {
  const [open, setOpen] = useState(level < openDepth);
  const label = name !== undefined && <span className="jt-key">{name}</span>;

  if (!isContainer(value)) {
    const d = describe(value);
    return (
      <div className="jt-row" style={{ paddingLeft: level * 16 + 18 }}>
        {label}
        {label && <span className="jt-colon">:</span>}
        <span className={SCALAR_CLASS[d.kind] ?? "jt-special"}>{d.kind === "String" ? JSON.stringify(d.text) : d.text}</span>
        {BADGE[d.kind] && <span className="jt-badge">{BADGE[d.kind]}</span>}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div>
      <div className="jt-row jt-toggle" style={{ paddingLeft: level * 16 }} onClick={() => setOpen(!open)}>
        <span className={"chev" + (open ? " open" : "")}>
          <Icon name="chevron" size={12} />
        </span>
        {label}
        {label && <span className="jt-colon">:</span>}
        <span className="jt-summary">
          {isArray ? `Array (${entries.length})` : `{ ${entries.length} ${entries.length === 1 ? t("campo") : t("campos")} }`}
        </span>
      </div>
      {open &&
        entries.map(([k, v]) => <JsonTree key={k} name={isArray ? `[${k}]` : k} value={v} openDepth={openDepth} level={level + 1} />)}
    </div>
  );
}
