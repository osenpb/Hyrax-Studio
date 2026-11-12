import { describe, expect, it } from "vitest";
import { buildFilter, buildProjection, buildSort } from "./mongoFilter";

const json = (s: string) => JSON.parse(s);

describe("buildFilter", () => {
  it("vacío = sin filtro y el JSON pasa tal cual", () => {
    expect(buildFilter("")).toBe("");
    expect(buildFilter("   ")).toBe("");
    expect(buildFilter('{ "a": 1 }')).toBe('{ "a": 1 }');
  });

  it("condiciones rápidas con tipos automáticos", () => {
    expect(json(buildFilter("status=OPEN age>30 active=true note=null"))).toEqual({
      status: "OPEN",
      age: { $gt: 30 },
      active: true,
      note: null,
    });
    expect(json(buildFilter("name=\"Ana María\", city='Lima'"))).toEqual({ name: "Ana María", city: "Lima" });
  });

  it("une rangos del mismo campo, regex sin distinguir mayúsculas, ObjectId y fechas", () => {
    expect(json(buildFilter("age>=18 age<65"))).toEqual({ age: { $gte: 18, $lt: 65 } });
    expect(json(buildFilter("name~ana"))).toEqual({ name: { $regex: "ana", $options: "i" } });
    expect(json(buildFilter("tipo!=A"))).toEqual({ tipo: { $ne: "A" } });
    expect(json(buildFilter("_id=507f1f77bcf86cd799439011"))).toEqual({ _id: { $oid: "507f1f77bcf86cd799439011" } });
    expect(json(buildFilter("created>=2026-03-01"))).toEqual({ created: { $gte: { $date: "2026-03-01T00:00:00.000Z" } } });
    expect(json(buildFilter("a.b.c=5"))).toEqual({ "a.b.c": 5 });
  });

  it("un número entre comillas sigue siendo texto", () => {
    expect(json(buildFilter('zip="01234"'))).toEqual({ zip: "01234" });
    expect(json(buildFilter("zip=01234"))).toEqual({ zip: 1234 });
  });

  it("explica lo que no entiende o no se puede combinar", () => {
    expect(() => buildFilter("hola")).toThrow(/No entiendo/);
    expect(() => buildFilter("a=1 b")).toThrow(/No entiendo/);
    expect(() => buildFilter("a=1 a=2")).toThrow(/dos veces/);
    expect(() => buildFilter("a=1 a>0")).toThrow(/igualdad/);
    expect(() => buildFilter("a>0 a=1")).toThrow(/igualdad|dos veces/);
    expect(() => buildFilter("{ a: 1 }")).toThrow(/JSON válido/);
    expect(() => buildFilter("{")).toThrow(/JSON válido/);
  });
});

describe("buildSort", () => {
  it("JSON, o campos con - para descendente", () => {
    expect(buildSort("")).toBe("");
    expect(buildSort('{ "a": -1 }')).toBe('{ "a": -1 }');
    expect(json(buildSort("-created name"))).toEqual({ created: -1, name: 1 });
    expect(json(buildSort("a:-1, b:1"))).toEqual({ a: -1, b: 1 });
    expect(() => buildSort("a:2")).toThrow(/No entiendo/);
    expect(() => buildSort("{ a: 1 }")).toThrow(/JSON válido/);
  });
});

describe("buildProjection", () => {
  it("incluye campos o los excluye, sin mezclar salvo -_id", () => {
    expect(buildProjection("")).toBe("");
    expect(json(buildProjection("name email"))).toEqual({ name: 1, email: 1 });
    expect(json(buildProjection("name -_id"))).toEqual({ name: 1, _id: 0 });
    expect(json(buildProjection("-password -token"))).toEqual({ password: 0, token: 0 });
    expect(() => buildProjection("name -password")).toThrow(/mezclar/);
    expect(buildProjection('{ "a": 1 }')).toBe('{ "a": 1 }');
  });
});
