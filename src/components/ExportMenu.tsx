import { useEffect, useRef, useState } from "react";
import type { ExportFormat } from "../api";
import Icon from "./Icon";
import { t } from "../i18n";

interface Props {
  disabled?: boolean;
  onExport: (format: ExportFormat) => void;
}

const OPTIONS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: "csv", label: "CSV", hint: "Excel y hojas de cálculo (UTF-8)" },
  { format: "json", label: "JSON", hint: "Arreglo de objetos con tipos" },
  { format: "sql", label: "SQL INSERT", hint: "Sentencias INSERT listas para ejecutar" },
];

export default function ExportMenu({ disabled, onExport }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="menu-wrap" ref={box}>
      <button onClick={() => setOpen((o) => !o)} disabled={disabled} title={t("Exportar el resultado a un archivo")}>
        <Icon name="download" size={13} /> {t("Exportar")}
      </button>
      {open && (
        <div className="menu">
          {OPTIONS.map((o) => (
            <button
              key={o.format}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onExport(o.format);
              }}
            >
              <strong>{o.label}</strong>
              <small>{t(o.hint)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
