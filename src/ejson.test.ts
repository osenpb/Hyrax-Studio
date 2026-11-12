import { describe, expect, it } from "vitest";
import { cellText, columnsOf, describe as classify, formatJson, formatShell, isContainer, toRelaxed } from "./ejson";

describe("describe (tipos BSON en JSON extendido canónico)", () => {
  it("reconoce los tipos numéricos y de texto", () => {
    expect(classify({ $numberInt: "5" })).toEqual({ kind: "Int32", text: "5" });
    expect(classify({ $numberLong: "9007199254740993" })).toEqual({ kind: "Int64", text: "9007199254740993" });
    expect(classify({ $numberDouble: "1.5" })).toEqual({ kind: "Double", text: "1.5" });
    expect(classify({ $numberDouble: "NaN" })).toEqual({ kind: "Double", text: "NaN" });
    expect(classify({ $numberDecimal: "12.50" })).toEqual({ kind: "Decimal128", text: "12.50" });
    expect(classify("hola")).toEqual({ kind: "String", text: "hola" });
    expect(classify(true)).toEqual({ kind: "Boolean", text: "true" });
    expect(classify(null)).toEqual({ kind: "Null", text: "null" });
  });

  it("reconoce ObjectId, fechas (canónica y relajada), binarios y marcas de tiempo", () => {
    expect(classify({ $oid: "507f1f77bcf86cd799439011" })).toEqual({ kind: "ObjectId", text: "507f1f77bcf86cd799439011" });
    expect(classify({ $date: { $numberLong: "1772323200000" } })).toEqual({ kind: "Date", text: "2026-03-01T00:00:00.000Z" });
    expect(classify({ $date: "2026-03-01T00:00:00Z" })).toEqual({ kind: "Date", text: "2026-03-01T00:00:00Z" });
    expect(classify({ $binary: { base64: "AAEC", subType: "00" } })).toEqual({ kind: "Binary", text: "Binary(00) AAEC" });
    expect(classify({ $binary: { base64: "AAAAAAAAAAAAAAAAAAAAAA==", subType: "04" } }).text).toMatch(/^UUID /);
    expect(classify({ $timestamp: { t: 1, i: 2 } })).toEqual({ kind: "Timestamp", text: "Timestamp(1, 2)" });
    expect(classify({ $regularExpression: { pattern: "^a", options: "i" } })).toEqual({ kind: "RegExp", text: "/^a/i" });
    expect(classify({ $minKey: 1 }).kind).toBe("MinKey");
    expect(classify({ $maxKey: 1 }).kind).toBe("MaxKey");
  });

  it("distingue documentos y arreglos de los tipos simples", () => {
    expect(classify([1, 2, 3])).toEqual({ kind: "Array", text: "[3]" });
    expect(classify({ a: 1, b: 2 })).toEqual({ kind: "Object", text: "{2}" });
    // Un documento normal con una sola clave que no es de BSON sigue siendo documento.
    expect(classify({ $oid2: "x" }).kind).toBe("Object");
    expect(classify({ city: "Lima" }).kind).toBe("Object");
    expect(isContainer([])).toBe(true);
    expect(isContainer({ a: 1 })).toBe(true);
    expect(isContainer({ $oid: "x" })).toBe(false);
    expect(isContainer("x")).toBe(false);
  });
});

describe("cellText", () => {
  it("muestra los tipos simples tal cual, null como vacío y un campo ausente como null", () => {
    expect(cellText({ $numberInt: "5" })).toBe("5");
    expect(cellText({ $oid: "abc" })).toBe("abc");
    expect(cellText("hola")).toBe("hola");
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
  });

  it("resume arreglos y documentos", () => {
    expect(cellText(["a", "b"])).toBe('["a", "b"]');
    expect(cellText({ city: "Lima", n: { $numberInt: "1" } })).toBe('{ city: "Lima", n: 1 }');
    expect(cellText([1, 2, 3, 4, 5, 6])).toContain("…");
    expect((cellText({ a: "x".repeat(500) }) ?? "").length).toBeLessThanOrEqual(121);
  });
});

describe("columnsOf", () => {
  it("pone _id primero y mantiene el orden de aparición", () => {
    const docs = [{ name: "a", _id: 1, age: 2 }, { email: "e", name: "b" }];
    expect(columnsOf(docs)).toEqual(["_id", "name", "age", "email"]);
  });
  it("funciona sin _id y respeta el máximo", () => {
    expect(columnsOf([{ a: 1, b: 2 }])).toEqual(["a", "b"]);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, i]));
    expect(columnsOf([wide], 10)).toHaveLength(10);
    expect(columnsOf([])).toEqual([]);
  });
});

describe("toRelaxed / formatJson", () => {
  it("los números normales salen como números y los tipos sin equivalente en JSON se conservan", () => {
    const doc = {
      _id: { $oid: "507f1f77bcf86cd799439011" },
      n: { $numberInt: "5" },
      big: { $numberLong: "5" },
      x: { $numberDouble: "1.5" },
      price: { $numberDecimal: "12.50" },
      at: { $date: { $numberLong: "1772323200000" } },
      tags: [{ $numberInt: "1" }, "a"],
      nested: { k: { $numberInt: "2" } },
    };
    expect(toRelaxed(doc)).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
      n: 5,
      big: 5,
      x: 1.5,
      price: { $numberDecimal: "12.50" },
      at: { $date: "2026-03-01T00:00:00.000Z" },
      tags: [1, "a"],
      nested: { k: 2 },
    });
  });

  it("no pierde datos: un Long fuera del rango seguro, NaN e Infinity conservan su envoltorio", () => {
    expect(toRelaxed({ $numberLong: "9007199254740993" })).toEqual({ $numberLong: "9007199254740993" });
    expect(toRelaxed({ $numberDouble: "NaN" })).toEqual({ $numberDouble: "NaN" });
    expect(toRelaxed({ $numberDouble: "Infinity" })).toEqual({ $numberDouble: "Infinity" });
  });

  it("formatJson da texto con sangría y no toca los valores simples", () => {
    expect(formatJson({ a: { $numberInt: "1" }, b: "x", c: null, d: true })).toBe(
      '{\n  "a": 1,\n  "b": "x",\n  "c": null,\n  "d": true\n}',
    );
    expect(toRelaxed("hola")).toBe("hola");
    expect(toRelaxed(null)).toBeNull();
  });
});

describe("formatShell (estilo mongosh y lista de Compass)", () => {
  it("claves sin comillas y los tipos como constructores", () => {
    const doc = {
      _id: { $oid: "681b964b042a8aacfe243aa7" },
      CategoryName: "Beverages",
      QuantityPerUnit: "10 boxes x 20 bags",
      UnitsInStock: { $numberInt: "39" },
      Discontinued: { $numberInt: "0" },
    };
    expect(formatShell(doc)).toBe(
      [
        "{",
        "  _id: ObjectId('681b964b042a8aacfe243aa7'),",
        '  CategoryName: "Beverages",',
        '  QuantityPerUnit: "10 boxes x 20 bags",',
        "  UnitsInStock: 39,",
        "  Discontinued: 0",
        "}",
      ].join("\n"),
    );
  });

  it("fechas, decimales, Long, binarios, regex y claves que necesitan comillas", () => {
    const text = formatShell({
      at: { $date: { $numberLong: "1772323200000" } },
      price: { $numberDecimal: "12.50" },
      small: { $numberLong: "5" },
      big: { $numberLong: "9007199254740993" },
      x: { $numberDouble: "1.5" },
      nan: { $numberDouble: "NaN" },
      id: { $binary: { base64: "EjRWeBI0VngSNFZ4EjRWeA==", subType: "04" } },
      raw: { $binary: { base64: "AAEC", subType: "00" } },
      ts: { $timestamp: { t: 1, i: 2 } },
      re: { $regularExpression: { pattern: "^a", options: "i" } },
      "campo con espacio": null,
      ok: true,
    });
    expect(text).toContain("at: ISODate('2026-03-01T00:00:00.000Z')");
    expect(text).toContain("price: Decimal128('12.50')");
    expect(text).toContain("small: 5,"); // un Long seguro es un número normal
    expect(text).toContain("big: Long('9007199254740993')");
    expect(text).toContain("x: 1.5,");
    expect(text).toContain("nan: NaN,");
    expect(text).toContain("id: UUID('12345678-1234-5678-1234-567812345678'),");
    expect(text).toContain("raw: BinData(0, 'AAEC')");
    expect(text).toContain("ts: Timestamp({ t: 1, i: 2 })");
    expect(text).toContain("re: /^a/i");
    expect(text).toContain('"campo con espacio": null');
    expect(text).toContain("ok: true");
  });

  it("documentos anidados con sangría y arreglos: simples en una línea, de documentos en varias", () => {
    const text = formatShell({
      addr: { city: "Lima", geo: { lat: { $numberDouble: "-12.04" } } },
      tags: ["web", "promo"],
      lineas: [{ sku: "A1" }, { sku: "B2" }],
      vacio: {},
      lista: [],
    });
    expect(text).toBe(
      [
        "{",
        "  addr: {",
        '    city: "Lima",',
        "    geo: {",
        "      lat: -12.04",
        "    }",
        "  },",
        '  tags: [ "web", "promo" ],',
        "  lineas: [",
        "    {",
        '      sku: "A1"',
        "    },",
        "    {",
        '      sku: "B2"',
        "    }",
        "  ],",
        "  vacio: {},",
        "  lista: []",
        "}",
      ].join("\n"),
    );
  });

  it("escapa las cadenas como JSON", () => {
    expect(formatShell({ a: 'x"y\nz' })).toBe('{\n  a: "x\\"y\\nz"\n}');
  });
});
