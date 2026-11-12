import { describe, expect, it } from "vitest";
import { collectFields, collectValues, mergeSample, suggestFields, suggestFilter } from "./mongoSuggest";

const docs = [
  {
    _id: { $oid: "507f1f77bcf86cd799439011" },
    estado: "ABIERTO",
    cliente: "Ana",
    total: { $numberDecimal: "12.50" },
    cantidad: { $numberInt: "3" },
    activo: true,
    envio: { ciudad: "Lima", dias: { $numberInt: "2" } },
    lineas: [{ sku: "A1" }, { sku: "B2" }],
    etiquetas: ["web", "promo"],
  },
  { _id: { $oid: "507f1f77bcf86cd799439012" }, estado: "CANCELADO", cliente: "Beto Ruiz", envio: { ciudad: "Quito" } },
];

const labels = (r: ReturnType<typeof suggestFilter>) => (r ? r.items.map((i) => i.label) : null);

describe("collectFields", () => {
  it("lista los campos con ruta, _id primero, anidados y arreglos de documentos", () => {
    const paths = collectFields(docs).map((f) => f.path);
    expect(paths[0]).toBe("_id");
    expect(paths).toEqual(
      expect.arrayContaining(["estado", "envio", "envio.ciudad", "envio.dias", "lineas", "lineas.sku", "etiquetas", "total"]),
    );
    const total = collectFields(docs).find((f) => f.path === "total");
    expect(total?.kinds).toEqual(["decimal"]);
  });

  it("respeta la profundidad y el máximo", () => {
    const deep = [{ a: { b: { c: { d: 1 } } } }];
    expect(collectFields(deep, 2).map((f) => f.path)).toEqual(["a", "a.b"]);
    const wide = [Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`c${i}`, i]))];
    expect(collectFields(wide, 3, 10)).toHaveLength(10);
  });
});

describe("collectValues", () => {
  it("devuelve valores distintos de tipos simples, también de campos anidados y de arreglos", () => {
    expect(collectValues(docs, "estado")).toEqual(["ABIERTO", "CANCELADO"]);
    expect(collectValues(docs, "envio.ciudad")).toEqual(["Lima", "Quito"]);
    expect(collectValues(docs, "lineas.sku")).toEqual(["A1", "B2"]);
    expect(collectValues(docs, "etiquetas")).toEqual(["web", "promo"]);
    expect(collectValues(docs, "cantidad")).toEqual(["3"]);
    expect(collectValues(docs, "activo")).toEqual(["true"]);
    expect(collectValues(docs, "envio")).toEqual([]); // un documento no es un valor simple
    expect(collectValues(docs, "no_existe")).toEqual([]);
  });
});

describe("mergeSample", () => {
  it("no repite documentos por _id y acota el tamaño", () => {
    const a = [{ _id: 1 }, { _id: 2 }];
    expect(mergeSample(a, [{ _id: 2 }, { _id: 3 }]).map((d) => d._id)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 10 }, (_, i) => ({ _id: i }));
    expect(mergeSample([], many, 4).map((d) => d._id)).toEqual([6, 7, 8, 9]);
  });
});

describe("suggestFilter (sintaxis rápida)", () => {
  it("campos: filtra por lo escrito, prefijo primero, y reemplaza el tramo con «campo=»", () => {
    const r = suggestFilter("est", 3, docs)!;
    expect(labels(r)).toEqual(["estado"]);
    expect(r.items[0].insert).toBe("estado=");
    expect([r.from, r.to]).toEqual([0, 3]);

    expect(labels(suggestFilter("ciu", 3, docs))).toEqual(["envio.ciudad"]); // también por contenido
    expect(suggestFilter("zzz", 3, docs)).toBeNull();
    expect(suggestFilter("", 0, docs)).toBeNull(); // sin nada escrito no molesta
    expect(labels(suggestFilter("", 0, docs, true))![0]).toBe("_id"); // Ctrl+Espacio
  });

  it("un campo completo ofrece los operadores", () => {
    const r = suggestFilter("cantidad", 8, docs)!;
    expect(r.items.slice(0, 7).map((i) => i.insert)).toEqual([
      "cantidad=",
      "cantidad!=",
      "cantidad>",
      "cantidad>=",
      "cantidad<",
      "cantidad<=",
      "cantidad~",
    ]);
    expect(r.items[2].detail).toBe("mayor que");
  });

  it("valores: tras el operador sugiere los valores vistos, filtrados por lo escrito", () => {
    const all = suggestFilter("estado=", 7, docs)!;
    expect(labels(all)).toEqual(["ABIERTO", "CANCELADO"]);
    expect([all.from, all.to]).toEqual([7, 7]);

    const some = suggestFilter("estado=CAN", 10, docs)!;
    expect(labels(some)).toEqual(["CANCELADO"]);
    expect([some.from, some.to]).toEqual([7, 10]);

    // Con un valor que tiene espacios se cita para que la sintaxis rápida lo entienda.
    const quoted = suggestFilter("cliente=", 8, docs)!;
    expect(quoted.items.map((i) => i.insert)).toEqual(["Ana", '"Beto Ruiz"']);

    expect(suggestFilter("estado=ZZ", 9, docs)).toBeNull();
  });

  it("trabaja sobre el token del cursor, no sobre toda la línea", () => {
    const text = "estado=ABIERTO env";
    const r = suggestFilter(text, text.length, docs)!;
    // Primero el más corto, y a igual prefijo el más corto antes.
    expect(labels(r)).toEqual(["envio", "envio.dias", "envio.ciudad"]);
    expect([r.from, r.to]).toEqual([15, 18]);

    // Cursor en medio del primer token.
    const mid = suggestFilter("est=ABIERTO x=1", 3, docs)!;
    expect([mid.from, mid.to]).toEqual([0, 11]);
  });

  it("no se confunde con comillas ni con comas dentro de un valor", () => {
    const text = 'cliente="Beto, R';
    // «Beto, R» no coincide con ningún valor visto («Beto Ruiz» no tiene coma): no sugiere nada, pero tampoco falla.
    expect(suggestFilter(text, text.length, docs)).toBeNull();
    const ok = 'cliente="Beto R';
    expect(labels(suggestFilter(ok, ok.length, docs))).toEqual(["Beto Ruiz"]);
  });
});

describe("suggestFilter (JSON)", () => {
  it("claves entre comillas", () => {
    const text = '{ "es';
    const r = suggestFilter(text, text.length, docs)!;
    expect(labels(r)).toEqual(["estado"]);
    expect(r.items[0].insert).toBe('estado"'); // cierra la comilla si falta
    expect([r.from, r.to]).toEqual([3, 5]);

    const closed = '{ "estado": "X", "cl" }';
    const r2 = suggestFilter(closed, closed.indexOf('"cl"') + 3, docs)!;
    expect(labels(r2)).toEqual(["cliente"]);
    expect(r2.items[0].insert).toBe("cliente"); // ya estaba cerrada
  });

  it("operadores que empiezan por $", () => {
    const text = '{ "cantidad": { "$g';
    expect(labels(suggestFilter(text, text.length, docs))).toEqual(["$gt", "$gte"]);
    const top = '{ "$o';
    expect(labels(suggestFilter(top, top.length, docs))).toEqual(["$or"]);
  });

  it("valores tras los dos puntos", () => {
    const text = '{ "estado": "AB';
    expect(labels(suggestFilter(text, text.length, docs))).toEqual(["ABIERTO"]);
    const none = '{ "estado": 5';
    expect(suggestFilter(none, none.length, docs)).toBeNull(); // fuera de una cadena
  });
});

describe("suggestFields (orden y campos)", () => {
  it("sugiere campos y conserva el signo -", () => {
    expect(suggestFields("-es", 3, docs)!.items[0].insert).toBe("-estado");
    expect(suggestFields("cli", 3, docs)!.items[0].insert).toBe("cliente");
    expect(suggestFields("", 0, docs)).toBeNull();
    expect(suggestFields("", 0, docs, true)!.items.length).toBeGreaterThan(0);
    expect(suggestFields("estado:", 7, docs)).toBeNull();
  });

  it("con varios campos completa solo el del cursor", () => {
    const text = "nombre -env cliente";
    const r = suggestFields(text, 11, docs)!;
    expect(r.items.map((i) => i.insert)).toEqual(["-envio", "-envio.dias", "-envio.ciudad"]);
    expect([r.from, r.to]).toEqual([7, 11]);
  });

  it("en JSON solo sugiere claves, no operadores", () => {
    const text = '{ "cli';
    expect(suggestFields(text, text.length, docs)!.items[0].label).toBe("cliente");
    const op = '{ "$gt';
    expect(suggestFields(op, op.length, docs)).toBeNull();
  });
});
