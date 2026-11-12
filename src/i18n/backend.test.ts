// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "./index";
import { translateBackend } from "./backend";

// Fuentes de Rust, leídos como texto (Vite los entrega crudos).
const sources = import.meta.glob("../../src-tauri/src/**/*.rs", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const STOPWORDS = /\b(el|la|los|las|no|se|con|de|del|que|por|para|una|un|al|en|es|hay|falta|puede|debe|esta|este|solo|tiempo|consulta|archivo|columna|tabla|fila)\b/i;
const NOT_MESSAGES = /^(SELECT|SET |DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|WITH|BEGIN|COMMIT|ROLLBACK|EXPLAIN|SHOW|FROM|WHERE|NO ACTION|\s)/;

/** Mensajes en español que el backend puede devolver (literales de los fuentes, sin el módulo de pruebas). */
function backendMessages(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const [path, src] of Object.entries(sources)) {
    // testing.rs son ayudas de las pruebas de Rust: nunca llegan al usuario
    if (path.endsWith("testing.rs")) continue;
    const cut = src.indexOf("#[cfg(test)]");
    const body = cut < 0 ? src : src.slice(0, cut);
    for (const line of body.split("\n")) {
      if (line.trim().startsWith("//")) continue;
      for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const raw = m[1];
        // {{ y }} son llaves literales en Rust; {nombre} es un dato variable
        const text = raw
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .replace(/\{\{/g, "\u0001")
          .replace(/\}\}/g, "\u0002")
          .replace(/\{[^}]*\}/g, "X")
          .replace(/\u0001/g, "{")
          .replace(/\u0002/g, "}");
        if (text.length > 8 && (/[áéíóúñ¿¡]/.test(text) || STOPWORDS.test(text)) && !NOT_MESSAGES.test(text)) {
          found.push({ file: path.split("src-tauri/")[1], text });
        }
      }
    }
  }
  return found;
}

describe("traducción de los mensajes del backend", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => setLang("es"));

  it("en español los mensajes se devuelven tal cual", () => {
    setLang("es");
    expect(translateBackend("La tabla no existe.")).toBe("La tabla no existe.");
  });

  it("traduce la plantilla y conserva los datos variables", () => {
    expect(translateBackend('La columna "total" no existe en la tabla.')).toBe('The column "total" does not exist in the table.');
    expect(translateBackend("Cambio 2 de 5: duplicate key value violates unique constraint\nNo se aplicó ningún cambio.")).toBe(
      "Change 2 of 5: duplicate key value violates unique constraint\nNo change was applied.",
    );
    expect(translateBackend("El archivo pesa 12.5 MB y el máximo es 8 MB.")).toBe("The file weighs 12.5 MB and the maximum is 8 MB.");
    expect(translateBackend("No se pudo conectar con el servidor SSH 10.0.0.5:22: Connection refused")).toBe(
      "Could not connect to the SSH server 10.0.0.5:22: Connection refused",
    );
  });

  it("los mensajes con nombres delante se traducen completos", () => {
    expect(translateBackend("El filtro no es JSON válido: expected value at line 1")).toBe("The filter is not valid JSON: expected value at line 1");
    expect(translateBackend("La proyección tiene un tipo no válido: x")).toBe("The projection has an invalid type: x");
  });

  it("no toca los errores que ya vienen en inglés del servidor", () => {
    const pg = 'ERROR: relation "orders" does not exist';
    expect(translateBackend(pg)).toBe(pg);
  });

  it("los datos con $ no se interpretan como referencias", () => {
    expect(translateBackend('La columna "$1" no existe en la tabla.')).toBe('The column "$1" does not exist in the table.');
  });

  it("todos los mensajes del backend tienen traducción (si añades uno nuevo en Rust, añade su regla)", () => {
    const messages = backendMessages();
    expect(messages.length).toBeGreaterThan(80);
    const missing = messages
      .filter(({ text }) => translateBackend(text) === text)
      // etiquetas sueltas y textos que no son mensajes al usuario
      .filter(({ text }) => !/^(El filtro|El orden|La proyección)$/.test(text));
    expect(missing.map((m) => `${m.file}: ${m.text}`)).toEqual([]);
  });

  it("ninguna traducción deja acentos del español", () => {
    for (const { file, text } of backendMessages()) {
      const out = translateBackend(text);
      expect(/[áéíóúñ¿¡«»]/.test(out), `${file}: ${out}`).toBe(false);
    }
  });
});
