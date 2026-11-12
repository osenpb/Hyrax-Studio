// Idioma de la interfaz. El texto original (en español) es la clave: `t("Nueva conexión")` devuelve el mismo
// texto en español y su traducción en inglés si el idioma es inglés. Lo que no tenga traducción se muestra en
// español, así que traducir por etapas nunca deja un texto vacío.

import { useSyncExternalStore } from "react";
import { en } from "./en";

export type Lang = "es" | "en";

export const LANGS: { code: Lang; name: string }[] = [
  { code: "es", name: "Español" },
  { code: "en", name: "English" },
];

const KEY = "hyrax-lang";

function isLang(v: unknown): v is Lang {
  return v === "es" || v === "en";
}

/** Idioma guardado; si no hay, inglés (el español es una opción en Ajustes). */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch {
    // sin almacenamiento: se usa el idioma por omisión
  }
  return "en";
}

let current: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // la elección vale solo para esta sesión
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

/** Traduce un texto. Los marcadores `{nombre}` se sustituyen con `params`. */
export function t(text: string, params?: Record<string, string | number>): string {
  const raw = current === "en" ? (en[text] ?? text) : text;
  return params ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : raw;
}

/** Suscribe un componente al idioma: se vuelve a dibujar cuando cambia. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getLang,
    getLang,
  );
}

if (typeof document !== "undefined") document.documentElement.lang = current;
