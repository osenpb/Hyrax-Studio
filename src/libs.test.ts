import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "./statements";
import { findParams, sqlLiteral, substituteParams, uniqueParams } from "./params";
import { heaviest, parsePlan } from "./plan";
import {
  applyMapping,
  autoMap,
  csvToTabular,
  detectDelimiter,
  parseCsv,
  parseJsonRows,
} from "./tabular";
import { diffResults } from "./compare";
import { joinSuggestions, tablesIn } from "./joins";
import { fuzzyScore, rank } from "./fuzzy";
import { parsePgArray } from "./pgarray";
import { bytes } from "./format";
import type { ForeignKey } from "./api";

describe("sentencias", () => {
  const script = "SELECT 1;\n\nSELECT ';' AS x, $$a;b$$ -- ; fin\n;\nDELETE FROM t WHERE id = 1";

  it("separa por ; ignorando cadenas, comentarios y bloques $$", () => {
    const parts = splitStatements(script).map((s) => s.text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("SELECT 1;");
    expect(parts[1]).toContain("$$a;b$$");
    expect(parts[2]).toBe("DELETE FROM t WHERE id = 1");
  });

  it("devuelve la sentencia bajo el cursor, y entre dos la anterior", () => {
    const at = (pos: number) => statementAt(script, pos)?.text;
    expect(at(3)).toBe("SELECT 1;");
    expect(at("SELECT 1;".length)).toBe("SELECT 1;");
    expect(at(script.indexOf("DELETE") + 4)).toBe("DELETE FROM t WHERE id = 1");
    expect(at("SELECT 1;\n".length)).toBe("SELECT 1;");
    expect(at(script.length)).toBe("DELETE FROM t WHERE id = 1");
  });

  it("no cuenta los fragmentos vacíos o solo comentarios", () => {
    expect(splitStatements(";;  ; -- nada\n")).toHaveLength(0);
    expect(statementAt("   ", 1)).toBeNull();
    expect(splitStatements("SELECT 1; -- final")).toHaveLength(1);
  });

  it("los desplazamientos son UTF-16 aunque haya emojis", () => {
    const sql = "SELECT '😀';\nSELECT 2;";
    const [a, b] = splitStatements(sql);
    expect(sql.slice(a.from, a.to)).toBe("SELECT '😀';");
    expect(sql.slice(b.from, b.to)).toBe("SELECT 2;");
    expect(statementAt(sql, sql.indexOf("SELECT 2") + 2)?.text).toBe("SELECT 2;");
  });
});

describe("parámetros con nombre", () => {
  it("detecta :nombre y descarta casts, cadenas y comentarios", () => {
    const sql = "SELECT :id::int, ':no', -- :tampoco\n a[1:2], b FROM t WHERE x = :id AND y = :Otro_1 /* :nope */";
    expect(uniqueParams(sql)).toEqual(["id", "Otro_1"]);
    expect(findParams("SELECT $$:x$$, :y")).toHaveLength(1);
  });

  it("sustituye por literales escapados, NULL y barras invertidas", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral("a\\b")).toBe("E'a\\\\b'");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(() => sqlLiteral("a\0b")).toThrow(/NUL/);
    expect(substituteParams("WHERE a = :a AND b = :b AND c = :a", { a: "1", b: null })).toBe(
      "WHERE a = '1' AND b = NULL AND c = '1'",
    );
  });

  it("un valor con comillas no puede escapar de su literal", () => {
    const out = substituteParams("SELECT :v", { v: "x'; DROP TABLE t; --" });
    expect(out).toBe("SELECT 'x''; DROP TABLE t; --'");
  });
});

describe("plan de ejecución", () => {
  const plan = JSON.stringify([
    {
      Plan: {
        "Node Type": "Nested Loop",
        "Startup Cost": 0,
        "Total Cost": 100,
        "Plan Rows": 10,
        "Actual Rows": 10,
        "Actual Total Time": 50,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "orders",
            Alias: "o",
            "Total Cost": 80,
            "Plan Rows": 5,
            "Actual Rows": 500,
            "Actual Total Time": 40,
            "Actual Loops": 1,
            Filter: "(total > 10)",
            "Rows Removed by Filter": 1000,
          },
          {
            "Node Type": "Index Scan",
            "Relation Name": "customers",
            "Index Name": "customers_pkey",
            "Total Cost": 10,
            "Plan Rows": 1,
            "Actual Rows": 1,
            "Actual Total Time": 0.1,
            "Actual Loops": 10,
          },
        ],
      },
      "Planning Time": 0.2,
      "Execution Time": 50.5,
    },
  ]);

  it("calcula el costo propio, el reparto y las estimaciones erradas", () => {
    const parsed = parsePlan(plan)!;
    expect(parsed.analyzed).toBe(true);
    expect(parsed.executionTime).toBe(50.5);
    const [seq, idx] = parsed.root.children;
    expect(parsed.root.exclusive).toBeCloseTo(50 - 40 - 1, 5);
    expect(seq.exclusive).toBe(40);
    expect(seq.share).toBeCloseTo(0.8, 5);
    expect(seq.misestimate).toBe(100);
    expect(seq.details).toContain("Filter: (total > 10)");
    expect(idx.misestimate).toBeNull();
    expect(heaviest(parsed)?.type).toBe("Seq Scan");
  });

  it("sin ANALYZE usa el costo estimado", () => {
    const parsed = parsePlan(JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Total Cost": 12.5, "Plan Rows": 3 } }]))!;
    expect(parsed.analyzed).toBe(false);
    expect(parsed.root.share).toBe(1);
  });

  it("devuelve null si no es un plan JSON", () => {
    expect(parsePlan("Seq Scan on orders")).toBeNull();
    expect(parsePlan("[]")).toBeNull();
    expect(parsePlan('[{"otra":1}]')).toBeNull();
  });
});

describe("importar CSV y JSON", () => {
  it("lee CSV con comillas, comas, saltos de línea y comillas dobles", () => {
    const rows = parseCsv('id,nota\r\n1,"hola, mundo"\r\n2,"línea 1\nlínea 2"\n3,"dijo ""sí"""\n', ",");
    expect(rows).toEqual([
      ["id", "nota"],
      ["1", "hola, mundo"],
      ["2", "línea 1\nlínea 2"],
      ["3", 'dijo "sí"'],
    ]);
    expect(parseCsv("﻿a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n,\n", ",")).toEqual([["a", "b"], ["", ""]]);
    expect(() => parseCsv('a,"sin cerrar', ",")).toThrow(/comillas/);
  });

  it("detecta el delimitador", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter('a,b\n"x;y;z",2')).toBe(",");
    expect(detectDelimiter("solo una columna\nvalor")).toBe(",");
  });

  it("convierte el CSV a tabla con o sin encabezado", () => {
    expect(csvToTabular([["id", ""], ["1", "x"], ["2"]], true)).toEqual({
      headers: ["id", "columna_2"],
      rows: [["1", "x"], ["2", ""]],
    });
    expect(csvToTabular([["1", "x"]], false).headers).toEqual(["columna_1", "columna_2"]);
  });

  it("lee JSON como arreglo de objetos, de arreglos o por líneas", () => {
    const objects = parseJsonRows('[{"id":1,"n":"a","t":true,"j":{"k":[1]}},{"id":2,"x":null}]');
    expect(objects.headers).toEqual(["id", "n", "t", "j", "x"]);
    expect(objects.rows[0]).toEqual(["1", "a", "true", '{"k":[1]}', null]);
    expect(objects.rows[1]).toEqual(["2", null, null, null, null]);
    expect(parseJsonRows('[["a","b"],[1,2]]')).toEqual({ headers: ["a", "b"], rows: [["1", "2"]] });
    expect(parseJsonRows('{"a":1}\n{"a":2}').rows).toEqual([["1"], ["2"]]);
    expect(() => parseJsonRows('{"a":1}')).toThrow(/arreglo/);
    expect(() => parseJsonRows("no json")).toThrow(/JSON/);
  });

  it("asigna columnas por nombre y aplica las opciones", () => {
    const headers = ["ID", "Nombre Completo", "extra"];
    expect(autoMap(["id", "nombre_completo", "otra"], headers)).toEqual([0, 1, null]);
    const mapped = applyMapping(
      { headers, rows: [["1", "  Ana ", ""], ["2", "", "x"]] },
      ["id", "nombre_completo", "otra"],
      [0, 1, null],
      { emptyAsNull: true, trim: true },
    );
    expect(mapped.columns).toEqual(["id", "nombre_completo"]);
    expect(mapped.rows).toEqual([["1", "Ana"], ["2", null]]);
    const raw = applyMapping({ headers, rows: [["1", "", ""]] }, ["id", "nombre_completo"], [0, 1], { emptyAsNull: false, trim: false });
    expect(raw.rows).toEqual([["1", ""]]);
  });
});

describe("comparar resultados", () => {
  const a = { columns: ["id", "nombre", "solo_a"], rows: [["1", "Ana", "x"], ["2", "Beto", "x"], ["3", "Caro", "x"]] };
  const b = { columns: ["id", "nombre", "solo_b"], rows: [["1", "Ana", "y"], ["2", "Berto", "y"], ["4", "Dani", "y"]] };

  it("con clave: iguales, modificadas, eliminadas y añadidas", () => {
    const diff = diffResults(a, b, ["id"]);
    expect(diff.columns).toEqual(["id", "nombre"]);
    expect(diff.counts).toEqual({ same: 1, changed: 1, removed: 1, added: 1 });
    expect([...diff.rows[1].changed]).toEqual([1]);
    expect(diff.onlyInA).toEqual(["solo_a"]);
    expect(diff.onlyInB).toEqual(["solo_b"]);
  });

  it("sin clave compara filas completas", () => {
    const diff = diffResults(a, b, []);
    expect(diff.counts).toEqual({ same: 1, changed: 0, removed: 2, added: 2 });
  });

  it("cuenta las claves repetidas y respeta los duplicados exactos", () => {
    const dup = { columns: ["id"], rows: [["1"], ["1"], ["2"]] };
    expect(diffResults(dup, dup, ["id"]).duplicateKeys).toBe(2);
    expect(diffResults(dup, dup, []).counts).toEqual({ same: 3, changed: 0, removed: 0, added: 0 });
    const fewer = { columns: ["id"], rows: [["1"], ["2"]] };
    expect(diffResults(dup, fewer, []).counts).toEqual({ same: 2, changed: 0, removed: 1, added: 0 });
  });

  it("distingue NULL de la cadena vacía", () => {
    const x = { columns: ["id", "v"], rows: [["1", null]] };
    const y = { columns: ["id", "v"], rows: [["1", ""]] };
    expect(diffResults(x, y, ["id"]).counts.changed).toBe(1);
  });
});

describe("JOIN sugerido por claves foráneas", () => {
  const fks: ForeignKey[] = [
    { name: "orders_customer_fk", schema: "public", table: "orders", columns: ["customer_id"], refSchema: "public", refTable: "customers", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
    { name: "items_order_fk", schema: "sales", table: "order_items", columns: ["order_id", "tenant"], refSchema: "public", refTable: "orders", refColumns: ["id", "tenant"], onUpdate: "NO ACTION", onDelete: "CASCADE" },
  ];

  it("encuentra las tablas y alias de FROM y JOIN", () => {
    expect(tablesIn("SELECT * FROM orders o JOIN sales.order_items AS i ON i.x = o.id WHERE 1=1")).toEqual([
      { schema: null, table: "orders", alias: "o" },
      { schema: "sales", table: "order_items", alias: "i" },
    ]);
    expect(tablesIn("SELECT * FROM orders WHERE x")).toEqual([{ schema: null, table: "orders", alias: null }]);
    expect(tablesIn("select * from orders left join customers on true")[0].alias).toBeNull();
  });

  it("sugiere hacia ambos lados con la condición ON", () => {
    const out = joinSuggestions("SELECT * FROM orders o JOIN ", fks);
    const customers = out.find((s) => s.label === "customers")!;
    expect(customers.insert).toBe("customers c ON c.id = o.customer_id");
    const items = out.find((s) => s.label === "order_items")!;
    expect(items.insert).toBe("sales.order_items oi ON oi.order_id = o.id AND oi.tenant = o.tenant");
  });

  it("evita alias repetidos y no sugiere sin tablas", () => {
    const out = joinSuggestions("SELECT * FROM orders c JOIN ", fks);
    expect(out.find((s) => s.label === "customers")!.insert).toBe("customers c2 ON c2.id = c.customer_id");
    expect(joinSuggestions("SELECT 1", fks)).toEqual([]);
  });
});

describe("utilidades", () => {
  it("fuzzy prioriza prefijos y coincidencias seguidas", () => {
    expect(fuzzyScore("ord", "orders")!).toBeGreaterThan(fuzzyScore("ord", "old_records_d")!);
    expect(fuzzyScore("zzz", "orders")).toBeNull();
    const items = ["public.customers", "public.orders", "sales.order_items"];
    expect(rank(items, "ord", (t) => [t.split(".")[1], t], 5)).toEqual(["public.orders", "sales.order_items"]);
    expect(rank(items, "", (t) => [t], 2)).toHaveLength(2);
  });

  it("lee arreglos de una dimensión", () => {
    expect(parsePgArray("{1,2,3}")).toEqual(["1", "2", "3"]);
    expect(parsePgArray('{"a b",NULL,"NULL","c\\"d"}')).toEqual(["a b", null, "NULL", 'c"d']);
    expect(parsePgArray("{}")).toEqual([]);
    expect(parsePgArray("{{1,2},{3,4}}")).toBeNull();
    expect(parsePgArray("no")).toBeNull();
  });

  it("formatea tamaños", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
    expect(bytes(null)).toBe("—");
  });
});
