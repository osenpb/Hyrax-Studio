import { useId, useRef, useState } from "react";
import type { SuggestResult } from "../mongoSuggest";
import { t } from "../i18n";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Enter sin una sugerencia elegida. */
  onSubmit: () => void;
  /** Calcula las sugerencias para el texto y la posición del cursor (`force`: Ctrl+Espacio). */
  suggest: (text: string, caret: number, force: boolean) => SuggestResult | null;
  ariaLabel: string;
  placeholder?: string;
  title?: string;
  className?: string;
}

/** Campo de texto con lista de sugerencias: flechas para elegir, Tab o Enter para aceptar, Esc para cerrar. */
export default function SuggestInput(props: Props) {
  const { value, onChange, onSubmit, suggest, ariaLabel, placeholder, title, className } = props;
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const refresh = (text: string, caret: number, force = false) => {
    const next = suggest(text, caret, force);
    setResult(next);
    setActive(-1);
  };

  const accept = (index: number) => {
    if (!result) return;
    const item = result.items[index];
    if (!item) return;
    const text = value.slice(0, result.from) + item.insert + value.slice(result.to);
    const caret = result.from + item.insert.length;
    onChange(text);
    // Tras aceptar un campo aparecen enseguida las sugerencias del siguiente paso (operador o valor).
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      refresh(text, caret);
    });
    setResult(null);
  };

  const open = result !== null && result.items.length > 0;

  return (
    <div className="suggest">
      <input
        ref={input}
        className={className}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        title={title}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart ?? value.length)}
        onBlur={() => setResult(null)}
        onKeyDown={(e) => {
          if (e.key === " " && e.ctrlKey) {
            e.preventDefault();
            refresh(value, e.currentTarget.selectionStart ?? value.length, true);
            return;
          }
          if (open) {
            const n = result!.items.length;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % n);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? n - 1 : a - 1));
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && active >= 0)) {
              e.preventDefault();
              accept(active >= 0 ? active : 0);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setResult(null);
              return;
            }
          }
          if (e.key === "Enter") {
            setResult(null);
            onSubmit();
          }
        }}
      />
      {open && (
        <ul className="suggest-list" role="listbox" id={listId} aria-label={t("Sugerencias de {name}", { name: ariaLabel.toLowerCase() })}>
          {result!.items.map((item, i) => (
            <li
              key={item.label + i}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              // mousedown (no click) para aceptar antes de que el campo pierda el foco
              onMouseDown={(e) => {
                e.preventDefault();
                accept(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="suggest-label">{item.label}</span>
              {item.detail && <span className="suggest-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
