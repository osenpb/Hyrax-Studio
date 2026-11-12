import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon from "./Icon";
import { t } from "../i18n";

export interface PaletteItem {
  key: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props {
  title: string;
  placeholder: string;
  search: (query: string) => PaletteItem[];
  /** Cambia cuando el conjunto de elementos cambia (por ejemplo, al terminar de cargar). */
  version?: unknown;
  status?: string | null;
  hint?: string;
  onPick: (item: PaletteItem, alternate: boolean) => void;
  onClose: () => void;
}

export default function Palette({ title, placeholder, search, version, status, hint, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => search(query), [search, query, version]);

  useEffect(() => setIndex(0), [query, version]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView?.({ block: "nearest" });
  }, [index, items]);

  const choose = (alternate: boolean) => {
    const item = items[index];
    if (item && !item.disabled) onPick(item, alternate);
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            aria-label={title}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(e.ctrlKey || e.metaKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {status && <div className="palette-empty">{status}</div>}
          {!status && items.length === 0 && <div className="palette-empty">{t("Sin coincidencias")}</div>}
          {items.map((item, i) => (
            <div
              key={item.key}
              role="option"
              aria-selected={i === index}
              className={"palette-item" + (i === index ? " active" : "") + (item.disabled ? " disabled" : "")}
              onMouseMove={() => setIndex(i)}
              onClick={() => !item.disabled && onPick(item, false)}
            >
              {item.icon}
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
        {hint && <div className="palette-hint">{hint}</div>}
      </div>
    </div>
  );
}
