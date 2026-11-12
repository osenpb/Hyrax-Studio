import { describe, expect, it } from "vitest";
import { cellText, columnsOf, describe as classify, isContainer } from "./ejson";

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
