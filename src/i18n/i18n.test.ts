// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "./en";
import { getLang, setLang, t } from "./index";

describe("t (idioma de la interfaz)", () => {
  beforeEach(() => setLang("es"));
  afterEach(() => setLang("es"));

  it("en español devuelve el texto original, con parámetros", () => {
    expect(t("Nueva conexión")).toBe("Nueva conexión");
    expect(t("{n} filas", { n: 3 })).toBe("3 filas");
  });

  it("en inglés traduce y, si falta la traducción, deja el español", () => {
    setLang("en");
    expect(t("Ajustes")).toBe("Settings");
    expect(t("Texto que nadie ha traducido")).toBe("Texto que nadie ha traducido");
  });

  it("sustituye los marcadores también en inglés y no toca los que no recibe", () => {
    en["{n} filas de prueba"] = "{n} test rows";
    setLang("en");
    expect(t("{n} filas de prueba", { n: 2 })).toBe("2 test rows");
    expect(t("{n} filas de prueba", { m: 2 })).toBe("{n} test rows");
    delete en["{n} filas de prueba"];
  });

  it("recuerda el idioma elegido y lo refleja en el documento", () => {
    setLang("en");
    expect(getLang()).toBe("en");
    expect(localStorage.getItem("hyrax-lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    setLang("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("si el almacenamiento falla, cambia igualmente de idioma", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("sin espacio");
    };
    try {
      setLang("en");
      expect(getLang()).toBe("en");
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("ninguna traducción está vacía ni conserva marcadores que no estén en el original", () => {
    for (const [es, english] of Object.entries(en)) {
      expect(english.trim(), es).not.toBe("");
      const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(marks(english), `marcadores de «${es}»`).toEqual(marks(es));
    }
  });
});

describe("idioma por omisión", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("sin preferencia guardada arranca en inglés, aunque el sistema esté en español", async () => {
    localStorage.clear();
    vi.spyOn(navigator, "language", "get").mockReturnValue("es-PE");
    vi.resetModules();
    const fresh = await import("./index");
    expect(fresh.getLang()).toBe("en");
    expect(fresh.t("Ajustes")).toBe("Settings");
  });

  it("con una preferencia guardada usa esa", async () => {
    localStorage.setItem("hyrax-lang", "es");
    vi.resetModules();
    const fresh = await import("./index");
    expect(fresh.getLang()).toBe("es");
    expect(fresh.t("Ajustes")).toBe("Ajustes");
  });

  it("ignora un valor guardado que no sea un idioma válido", async () => {
    localStorage.setItem("hyrax-lang", "fr");
    vi.resetModules();
    expect((await import("./index")).getLang()).toBe("en");
  });
});
