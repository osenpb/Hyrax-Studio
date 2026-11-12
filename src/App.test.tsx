// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLang, setLang } from "./i18n";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";

let holdRuns = false;
let productionProfile = false;
let applyError: string | null = null;
let saveResult: string | null = "C:/tmp/export.csv";
let failDatabases = false;
let readOnlyState = true;
let pendingRun: { resolve: (v: unknown) => void } | null = null;
let planJson = false;
let openedFile: { path: string; name: string; content: string } | null = null;
let importError: string | null = null;
let dropError: string | null = null;
let profilesCleared = false;
let withMongoProfile = false;
let mongoConnectError = "";
let mongoFindError = "";
let mongoSystemDbs = false;
let boolColumn = false;
const calls: { cmd: string; args: Record<string, unknown> }[] = [];

const structureOf = (table: string) => ({
  kind: "table",
  comment: null,
  columns: [
    { name: "id", dataType: "bigint", nullable: false, default: null, isPrimaryKey: true, identity: null, generated: false, collation: null, comment: null },
    { name: "total", dataType: "integer", nullable: true, default: null, isPrimaryKey: false, identity: null, generated: false, collation: null, comment: "monto" },
    { name: "meta", dataType: "jsonb", nullable: true, default: null, isPrimaryKey: false, identity: null, generated: false, collation: null, comment: null },
    ...(boolColumn
      ? [{ name: "active", dataType: "boolean", nullable: true, default: null, isPrimaryKey: false, identity: null, generated: false, collation: null, comment: null }]
      : []),
  ],
  indexes: [
    { name: `${table}_pkey`, definition: `CREATE UNIQUE INDEX ${table}_pkey ON public.${table} USING btree (id)`, unique: true, primary: true, valid: true, sizeBytes: 8192, backsConstraint: true },
  ],
  constraints: [{ name: `${table}_pkey`, kind: "primary", definition: "PRIMARY KEY (id)", validated: true }],
  foreignKeys:
    table === "orders"
      ? [{ name: "orders_total_fk", schema: "public", table: "orders", columns: ["total"], refSchema: "public", refTable: "totals", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }]
      : [],
  referencedBy:
    table === "orders"
      ? [{ name: "items_order_fk", schema: "public", table: "order_items", columns: ["order_id"], refSchema: "public", refTable: "orders", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" }]
      : [],
  triggers: [],
  stats: { estimatedRows: 1, totalBytes: 16384, tableBytes: 8192, indexBytes: 8192, deadTuples: 0, lastVacuum: null, lastAnalyze: null, seqScans: 3, idxScans: 9 },
});

const planResult = {
  results: [
    {
      columns: ["QUERY PLAN"],
      rows: [
        [
          JSON.stringify([
            {
              Plan: {
                "Node Type": "Nested Loop",
                "Total Cost": 100,
                "Plan Rows": 10,
                Plans: [
                  { "Node Type": "Seq Scan", "Relation Name": "orders", "Total Cost": 90, "Plan Rows": 10 },
                  { "Node Type": "Index Scan", "Relation Name": "customers", "Index Name": "customers_pkey", "Total Cost": 5, "Plan Rows": 1 },
                ],
              },
            },
          ]),
        ],
      ],
      totalRows: 1,
      truncated: false,
      totalIsLowerBound: false,
      affected: null,
    },
  ],
  elapsedMs: 2,
};

const profile = {
  id: "p1",
  name: "dev_erp",
  host: "h",
  port: 5432,
  database: "postgres",
  user: "u",
  password: "",
  sslMode: "disable",
  readOnly: true,
  production: false,
};

/** La pantalla de inicio repite el nombre de las conexiones: estas pruebas buscan solo en la barra lateral. */
const inSidebar = () => within(document.querySelector("aside") as HTMLElement);

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => saveResult),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_profiles": {
        if (profilesCleared) return [];
        const list: unknown[] = [{ ...profile, production: productionProfile, hasPassword: true, caCertPath: null }];
        if (withMongoProfile) {
          list.push({
            ...profile,
            id: "m1",
            name: "mongo_demo",
            host: "mongo.example.com",
            port: 27017,
            user: "ana",
            engine: "mongodb",
            mongo: { extraHosts: "", authSource: null, replicaSet: null, directConnection: false },
            hasPassword: true,
            caCertPath: null,
          });
        }
        return list;
      }
      case "mongo_connect":
        if (mongoConnectError) throw mongoConnectError;
        return { version: "MongoDB 8.0.6", readOnly: true };
      case "mongo_list_databases":
        return [
          ...(mongoSystemDbs ? [{ name: "admin", sizeOnDisk: 139264, empty: false }] : []),
          { name: "ventas", sizeOnDisk: 20480, empty: false },
          ...(mongoSystemDbs
            ? [
                { name: "config", sizeOnDisk: 106496, empty: false },
                { name: "local", sizeOnDisk: 65536, empty: false },
              ]
            : []),
        ];
      case "mongo_list_collections":
        return [
          { name: "open_orders", kind: "view" },
          { name: "orders", kind: "collection" },
        ];
      case "mongo_find":
        if (mongoFindError) throw mongoFindError;
        return {
          documents: [
            '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"name":"Ana","age":{"$numberInt":"30"},"addr":{"city":"Lima"}}',
            '{"_id":{"$oid":"507f1f77bcf86cd799439012"},"name":"Beto","age":{"$numberInt":"41"}}',
            '{"_id":{"$oid":"507f1f77bcf86cd799439013"},"name":"Cora","age":{"$numberInt":"25"}}',
          ],
          truncated: false,
          elapsedMs: 3,
        };
      case "mongo_estimated_count":
        return 3;
      case "mongo_count":
        return 2;
      case "connect_profile":
        return { version: "PostgreSQL 16", readOnly: readOnlyState };
      case "set_read_only":
        readOnlyState = args.enabled as boolean;
        return readOnlyState;
      case "cancel_query":
        pendingRun?.resolve({ results: [], elapsedMs: 1 });
        return;
      case "table_data":
        return {
          result: {
            columns: boolColumn ? ["id", "total", "meta", "active"] : ["id", "total", "meta"],
            rows: [boolColumn ? ["1", "10", '{"a":{"b":2}}', "t"] : ["1", "10", '{"a":{"b":2}}']],
            totalRows: 1,
            truncated: false,
            totalIsLowerBound: false,
            affected: null,
          },
          estimatedRows: 1,
          elapsedMs: 1,
        };
      case "count_rows":
        return 3;
      case "export_table":
        return { rows: 3 };
      case "export_sql":
        return { rows: 1 };
      case "save_profile":
      case "delete_profile":
        return;
      case "completion_schema":
        return [{ schema: "public", table: "orders", columns: ["id", "total"] }];
      case "run_sql": {
        if (holdRuns) {
          return new Promise((resolve) => {
            pendingRun = { resolve };
          });
        }
        const text = String(args.sql);
        if (text.startsWith("EXPLAIN") && planJson) return planResult;
        if (text.startsWith("EXPLAIN")) {
          return {
            results: [
              {
                columns: ["QUERY PLAN"],
                rows: [["Seq Scan on orders"], ["  Filter: (id = 1)"]],
                totalRows: 2,
                truncated: false,
                totalIsLowerBound: false,
                affected: null,
              },
            ],
            elapsedMs: 3,
          };
        }
        return {
          results: [
            { columns: ["a"], rows: [["1"]], totalRows: 1, truncated: false, totalIsLowerBound: false, affected: null },
          ],
          elapsedMs: 2,
        };
      }
      case "list_databases":
        if (failDatabases) throw "permiso denegado para pg_database";
        return ["erp_db", "postgres"];
      case "list_schemas":
        return [
          { name: "public", isSystem: false },
          { name: "information_schema", isSystem: true },
        ];
      case "list_relations":
        return args.id === "p1::erp_db"
          ? [{ name: "orders", kind: "table" }]
          : [];
      case "list_columns":
        return [
          { name: "id", dataType: "bigint", nullable: false, default: null, isPrimaryKey: true },
          { name: "total", dataType: "integer", nullable: true, default: null, isPrimaryKey: false },
          { name: "meta", dataType: "jsonb", nullable: true, default: null, isPrimaryKey: false },
          ...(boolColumn ? [{ name: "active", dataType: "boolean", nullable: true, default: null, isPrimaryKey: false }] : []),
        ];
      case "preview_changes":
        return ['UPDATE "public"."orders" SET "total" = \'11\'::integer WHERE "id" = \'1\'::bigint;'];
      case "apply_changes":
        if (applyError) throw applyError;
        return { updated: 1, deleted: 0, inserted: 0 };
      case "run_sql_dry":
        return {
          results: [{ columns: [], rows: [], totalRows: 0, truncated: false, totalIsLowerBound: false, affected: 1 }],
          elapsedMs: 2,
        };
      case "search_objects":
        return [
          { schema: "public", name: "orders", kind: "table", detail: null, oid: 1 },
          { schema: "public", name: "totals", kind: "table", detail: null, oid: 2 },
          { schema: "public", name: "order_total", kind: "function", detail: "id bigint", oid: 3 },
        ];
      case "completion_fks":
        return [];
      case "table_structure":
        return structureOf(String(args.table));
      case "object_ddl":
        return `CREATE TABLE "public"."${String(args.name)}" (\n    "id" bigint NOT NULL\n);\n`;
      case "open_text_file":
        return openedFile;
      case "save_text_file":
        return { path: "C:/scripts/consulta.sql", name: "consulta.sql", content: "" };
      case "test_connection":
        return args.profile && (args.profile as { engine?: string }).engine === "mongodb" ? "MongoDB 8.0.3" : "PostgreSQL 16";
      case "reset_app_data":
        if (args.confirm !== "BORRAR") throw "confirmación incorrecta";
        profilesCleared = true;
        return 1;
      case "drop_object":
        if (dropError) throw dropError;
        return `DROP TABLE "${String(args.schema)}"."${String(args.name)}"`;
      case "drop_database":
        if (dropError) throw dropError;
        return `DROP DATABASE "${String(args.database)}"`;
      case "import_rows":
        if (importError) throw importError;
        return { inserted: (args.rows as unknown[]).length, rolledBack: args.dryRun === true };
      default:
        throw new Error("comando no simulado: " + cmd);
    }
  }),
}));

import { format as formatSql } from "sql-formatter";
import { parseFilter } from "./filters";
import { toJsonRows, toTsv, tryParseJson } from "./clipboard";
import { emptyPending, pendingCount, pkOf, rowKeyOf, stageCellEdit, stageDelete, summarize, toChangeSet } from "./editing";
import { findDangers } from "./sqlscan";
import App from "./App";

const emptyRects = Object.assign([], { item: () => null });
Range.prototype.getClientRects = () => emptyRects as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

beforeEach(() => {
  profilesCleared = false;
  withMongoProfile = false;
  mongoConnectError = "";
  mongoFindError = "";
  mongoSystemDbs = false;
  boolColumn = false;
  localStorage.removeItem("hyrax-recent");
  calls.length = 0;
  failDatabases = false;
  readOnlyState = true;
  holdRuns = false;
  productionProfile = false;
  applyError = null;
  saveResult = "C:/tmp/export.csv";
  pendingRun = null;
  planJson = false;
  openedFile = null;
  importError = null;
  dropError = null;
  localStorage.clear();
  // Las pruebas de MongoDB parten de la tabla y del árbol, salvo las que prueban el valor por omisión.
  setLang("es");
  localStorage.setItem("hyrax-mongo-view", "table");
  localStorage.setItem("hyrax-mongo-viewer", "tree");
});
afterEach(cleanup);

describe("navegador", () => {
  it("al abrir el servidor lista sus bases de datos", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));

    expect(await screen.findByText("erp_db")).toBeTruthy();
    expect(await screen.findByText("postgres")).toBeTruthy();
    expect(await screen.findByText("public")).toBeTruthy();
  });

  it("un segundo clic mientras conecta no cierra el servidor", async () => {
    const user = userEvent.setup();
    render(<App />);
    const row = await inSidebar().findByText("dev_erp");
    await user.click(row);
    await user.click(row);
    await user.click(row);

    expect(await screen.findByText("erp_db")).toBeTruthy();
    expect(calls.filter((c) => c.cmd === "connect_profile").length).toBe(1);
  });

  it("si falla la lista de bases muestra el error en vez de quedarse cargando", async () => {
    failDatabases = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));

    expect(await screen.findByText(/permiso denegado/)).toBeTruthy();
    expect(screen.queryByText("Cargando…")).toBeNull();
  });

  it("reintenta cargar las bases al reabrir un servidor ya conectado", async () => {
    failDatabases = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText(/permiso denegado/);

    failDatabases = false;
    await user.click(inSidebar().getByText("dev_erp"));
    expect(await screen.findByText("erp_db")).toBeTruthy();
    expect(screen.queryByText(/permiso denegado/)).toBeNull();
  });

  it("al abrir otra base muestra sus tablas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));

    await waitFor(() => expect(calls.some((c) => c.cmd === "connect_profile" && c.args.database === "erp_db")).toBe(true));
    const publics = await screen.findAllByText("public");
    await user.click(publics[publics.length - 1]);
    expect(await screen.findByText("orders")).toBeTruthy();
  });

  it("el editor SQL abre en solo lectura y pide confirmación para habilitar escritura", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);

    const chip = await screen.findByText("Solo lectura", { selector: "button *, button" });
    await user.click(chip);
    expect(await screen.findByText(/Vas a permitir escrituras/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "set_read_only")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Habilitar escritura" }));
    expect(await screen.findByText("Escritura habilitada")).toBeTruthy();
    const call = calls.find((c) => c.cmd === "set_read_only");
    expect(call?.args.enabled).toBe(false);

    await user.click(screen.getByText("Escritura habilitada"));
    expect(await screen.findByText("Solo lectura", { selector: "button *, button" })).toBeTruthy();
  });

  it("una consulta en curso muestra Cancelar y lo envía al backend", async () => {
    holdRuns = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);

    await user.click(await screen.findByText("Ejecutar"));
    const cancel = await screen.findByText("Cancelar");
    await user.click(cancel);

    await waitFor(() => expect(calls.some((c) => c.cmd === "cancel_query")).toBe(true));
    expect(await screen.findByText("Ejecutar")).toBeTruthy();
  });

  async function openSql(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);
  }

  it("el editor pide el esquema para autocompletar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSql(user);
    await waitFor(() => expect(calls.some((c) => c.cmd === "completion_schema")).toBe(true));
  });

  it("guarda lo ejecutado en el historial y permite recargarlo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSql(user);
    await user.click(await screen.findByText("Ejecutar"));
    await screen.findByText("Historial (1)");

    await user.click(screen.getByText("Historial (1)"));
    const item = await screen.findByTitle("SELECT 1;");
    expect(item).toBeTruthy();
    await user.click(item);
    expect(screen.queryByText("Clic para cargar la consulta en el editor")).toBeNull();
  });

  it("Explicar envía EXPLAIN y muestra el plan como texto", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSql(user);
    await user.click(await screen.findByText("Explicar"));

    const sent = calls.filter((c) => c.cmd === "run_sql").map((c) => String(c.args.sql));
    expect(sent[sent.length - 1]).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
    expect(await screen.findByText(/Seq Scan on orders/)).toBeTruthy();
    expect(screen.getByText("Plan de ejecución")).toBeTruthy();
  });

  it("Analizar solo está disponible en solo lectura", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSql(user);
    const analyze = (await screen.findByText("Analizar")) as HTMLButtonElement;
    expect(analyze.disabled).toBe(false);

    await user.click(screen.getByText("Solo lectura"));
    await user.click(await screen.findByRole("button", { name: "Habilitar escritura" }));
    await screen.findByText("Escritura habilitada");
    expect((screen.getByText("Analizar") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("formateo", () => {
  it("pone las palabras clave en mayúsculas y ordena la consulta", () => {
    const out = formatSql("select id,total from orders where id=1", { language: "postgresql", keywordCase: "upper", tabWidth: 2 });
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM");
    expect(out.includes("\n")).toBe(true);
  });
});

describe("filtros de columna", () => {
  it("interpreta los operadores escritos en la caja", () => {
    expect(parseFilter("a", "")).toBeNull();
    expect(parseFilter("a", "  ")).toBeNull();
    expect(parseFilter("a", "foo")).toEqual({ column: "a", op: "contains", value: "foo" });
    expect(parseFilter("a", "=foo")).toEqual({ column: "a", op: "equals", value: "foo" });
    expect(parseFilter("a", "!= foo")).toEqual({ column: "a", op: "not_equals", value: "foo" });
    expect(parseFilter("a", ">=5")).toEqual({ column: "a", op: "gte", value: "5" });
    expect(parseFilter("a", "<5")).toEqual({ column: "a", op: "lt", value: "5" });
    expect(parseFilter("a", "^ab")).toEqual({ column: "a", op: "starts_with", value: "ab" });
    expect(parseFilter("a", "null")).toEqual({ column: "a", op: "is_null", value: null });
    expect(parseFilter("a", "!null")).toEqual({ column: "a", op: "not_null", value: null });
    expect(parseFilter("a", ">")).toBeNull();
  });

  async function openOrders(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));
    const orders = await screen.findByText("orders");
    await user.dblClick(orders);
    await screen.findByLabelText("Filtrar total");
  }

  it("envía los filtros al backend con un pequeño retraso y reinicia la página", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrders(user);

    await user.type(screen.getByLabelText("Filtrar total"), ">5");
    await waitFor(() => {
      const last = calls.filter((c) => c.cmd === "table_data").pop();
      expect(last?.args.filters).toEqual([{ column: "total", op: "gt", value: "5" }]);
      expect(last?.args.offset).toBe(0);
    });
    expect(screen.getByText(/con filtros/)).toBeTruthy();
  });

  it("limpiar filtros vuelve a pedir la tabla sin filtros", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrders(user);
    await user.type(screen.getByLabelText("Filtrar total"), "9");
    await screen.findByText(/Limpiar filtros/);
    await waitFor(() => {
      expect(calls.filter((c) => c.cmd === "table_data").pop()?.args.filters).toHaveLength(1);
    });

    await user.click(screen.getByText(/Limpiar filtros/));
    await waitFor(() => {
      expect(calls.filter((c) => c.cmd === "table_data").pop()?.args.filters).toEqual([]);
    });
  });
});

describe("exportación", () => {
  it("exporta la tabla filtrada al archivo elegido", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));
    await user.dblClick(await screen.findByText("orders"));
    await user.type(await screen.findByLabelText("Filtrar id"), "=7");
    await waitFor(() => {
      expect(calls.filter((c) => c.cmd === "table_data").pop()?.args.filters).toHaveLength(1);
    });

    await user.click(screen.getAllByText("Exportar")[0]);
    await user.click(await screen.findByText("CSV"));

    await waitFor(() => expect(calls.some((c) => c.cmd === "export_table")).toBe(true));
    const call = calls.find((c) => c.cmd === "export_table");
    expect(call?.args.format).toBe("csv");
    expect(call?.args.path).toBe("C:/tmp/export.csv");
    expect(call?.args.filters).toEqual([{ column: "id", op: "equals", value: "7" }]);
    expect(await screen.findByText(/Se exportaron 3 filas/)).toBeTruthy();
  });

  it("si cancelas el diálogo no exporta nada", async () => {
    saveResult = null;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));
    await user.dblClick(await screen.findByText("orders"));
    await screen.findByLabelText("Filtrar id");

    await user.click(screen.getAllByText("Exportar")[0]);
    await user.click(await screen.findByText("JSON"));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.cmd === "export_table")).toBe(false);
  });

  it("exporta la consulta del editor SQL", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);

    await user.click(await screen.findByText("Exportar"));
    await user.click(await screen.findByText("SQL INSERT"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "export_sql")).toBe(true));
    const call = calls.find((c) => c.cmd === "export_sql");
    expect(call?.args.format).toBe("sql");
    expect(call?.args.sql).toBe("SELECT 1;");
  });
});

describe("portapapeles", () => {
  it("TSV entrecomilla tabulaciones, saltos y comillas; NULL sale vacío", () => {
    expect(toTsv(["a", "b"], [["1", null], ["x\ty", 'say "hi"'], ["l1\nl2", "ok"]])).toBe(
      'a\tb\n1\t\n"x\ty"\t"say ""hi"""\n"l1\nl2"\tok',
    );
  });

  it("JSON de filas conserva NULL y el orden de columnas", () => {
    const out = JSON.parse(toJsonRows(["b", "a"], [["1", null]]));
    expect(out).toEqual([{ b: "1", a: null }]);
    expect(Object.keys(out[0])).toEqual(["b", "a"]);
  });

  it("detecta JSON solo en objetos y arreglos válidos", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson(" [1,2] ")).toEqual([1, 2]);
    expect(tryParseJson("123")).toBeUndefined();
    expect(tryParseJson("{roto")).toBeUndefined();
    expect(tryParseJson(null)).toBeUndefined();
  });
});

describe("rejilla de datos", () => {
  async function openOrdersTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));
    await user.dblClick(await screen.findByText("orders"));
    await screen.findByLabelText("Filtrar total");
  }

  const lastOrder = () => calls.filter((c) => c.cmd === "table_data").pop()?.args.order;

  it("clic ordena por una columna y Mayús+clic añade más columnas al orden", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrdersTab(user);

    await user.click(screen.getByText("id", { selector: "th" }));
    await waitFor(() => expect(lastOrder()).toEqual([{ column: "id", descending: false }]));

    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("total", { selector: "th" }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastOrder()).toEqual([
        { column: "id", descending: false },
        { column: "total", descending: false },
      ]),
    );

    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("total", { selector: "th" }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastOrder()).toEqual([
        { column: "id", descending: false },
        { column: "total", descending: true },
      ]),
    );

    await user.click(screen.getByText("meta", { selector: "th" }));
    await waitFor(() => expect(lastOrder()).toEqual([{ column: "meta", descending: false }]));
  });

  it("sin orden elegido ordena por clave primaria y pide la tabla una sola vez", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrdersTab(user);
    await new Promise((r) => setTimeout(r, 100));

    const requests = calls.filter((c) => c.cmd === "table_data");
    expect(requests).toHaveLength(1);
    expect(requests[0].args.order).toEqual([{ column: "id", descending: false }]);

    await user.click(screen.getByText("total", { selector: "th" }));
    await user.click(screen.getByText("total", { selector: "th" }));
    await user.click(screen.getByText("total", { selector: "th" }));
    await waitFor(() => expect(lastOrder()).toEqual([{ column: "id", descending: false }]));
  });

  it("selecciona filas y las copia como TSV", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrdersTab(user);

    await user.click(screen.getByTitle(/seleccionar fila/));
    expect(await screen.findByText("1 fila seleccionada")).toBeTruthy();
    await user.click(screen.getByText(/Copiar TSV/));
    expect(await navigator.clipboard.readText()).toBe('id\ttotal\tmeta\n1\t10\t"{""a"":{""b"":2}}"');
    expect(await screen.findByText("Copiado")).toBeTruthy();

    await user.click(screen.getByText("Quitar selección"));
    expect(screen.queryByText("1 fila seleccionada")).toBeNull();
  });

  it("muestra el JSON formateado en el inspector y permite ver el valor crudo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrdersTab(user);

    await user.click(screen.getByText('{"a":{"b":2}}'));
    expect(await screen.findByText(/"b": 2/)).toBeTruthy();

    await user.click(screen.getByText("Crudo"));
    const raw = await screen.findAllByText('{"a":{"b":2}}');
    expect(raw.some((el) => el.tagName === "PRE")).toBe(true);
  });
});

describe("cambios pendientes (lógica pura)", () => {
  const pkA = { id: "1" };

  it("editar una celda registra el valor original y volver al original lo quita", () => {
    let p = stageCellEdit(emptyPending, "k1", pkA, "name", "Ana", "Beto");
    expect(p.updates.k1).toEqual({ pk: pkA, original: { name: "Ana" }, set: { name: "Beto" } });
    p = stageCellEdit(p, "k1", pkA, "age", null, "30");
    expect(p.updates.k1.set).toEqual({ name: "Beto", age: "30" });
    expect(p.updates.k1.original).toEqual({ name: "Ana", age: null });
    p = stageCellEdit(p, "k1", pkA, "name", "Ana", "Ana");
    expect(Object.keys(p.updates.k1.set)).toEqual(["age"]);
    p = stageCellEdit(p, "k1", pkA, "age", null, null);
    expect(p.updates).toEqual({});
    expect(pendingCount(p)).toBe(0);
  });

  it("marcar para eliminar descarta las ediciones de esa fila y se puede deshacer", () => {
    let p = stageCellEdit(emptyPending, "k1", pkA, "name", "Ana", "Beto");
    p = stageDelete(p, [{ key: "k1", pk: pkA }]);
    expect(p.updates).toEqual({});
    expect(p.deletes).toEqual({ k1: pkA });
    p = stageDelete(p, [{ key: "k1", pk: pkA }]);
    expect(p.deletes).toEqual({});
  });

  it("arma el conjunto de cambios sin las columnas por defecto de las filas nuevas", () => {
    const p = {
      ...emptyPending,
      updates: { k1: { pk: pkA, original: { a: "1" }, set: { a: "2" } } },
      deletes: { k2: { id: "2" } },
      inserts: [
        {
          id: 1,
          values: {
            name: { mode: "value" as const, value: "N" },
            age: { mode: "null" as const },
            id: { mode: "default" as const },
          },
        },
      ],
    };
    expect(toChangeSet(p)).toEqual({
      updates: [{ pk: pkA, original: { a: "1" }, set: { a: "2" } }],
      deletes: [{ pk: { id: "2" } }],
      inserts: [{ values: { name: { mode: "value", value: "N" }, age: { mode: "null" } } }],
    });
    expect(summarize(p)).toBe("1 fila modificada · 1 fila nueva · 1 fila eliminada");
    expect(rowKeyOf([0, 2], ["a", "b", null])).toBe('["a",null]');
    expect(pkOf(["id"], [1], ["x", "7"])).toEqual({ id: "7" });
  });
});

describe("detección de sentencias peligrosas", () => {
  it("avisa de DELETE/UPDATE sin WHERE, TRUNCATE y DROP", () => {
    expect(findDangers("DELETE FROM t").map((d) => d.label)).toEqual([expect.stringContaining("DELETE sin WHERE")]);
    expect(findDangers("update t set a = 1")[0].label).toContain("UPDATE sin WHERE");
    expect(findDangers("TRUNCATE t")[0].label).toContain("TRUNCATE");
    expect(findDangers("drop table t")[0].label).toContain("DROP");
    expect(findDangers("ALTER TABLE t DROP COLUMN a")[0].label).toContain("ALTER");
  });

  it("no avisa cuando hay WHERE ni con texto engañoso en comentarios o cadenas", () => {
    expect(findDangers("DELETE FROM t WHERE id = 1")).toEqual([]);
    expect(findDangers("UPDATE t SET a = 1 WHERE b = 2; SELECT 1")).toEqual([]);
    expect(findDangers("SELECT 'DELETE FROM t' -- DROP TABLE t")).toEqual([]);
    expect(findDangers("SELECT 1 /* TRUNCATE t */")).toEqual([]);
    expect(findDangers("DELETE FROM t -- WHERE id = 1")[0].label).toContain("DELETE sin WHERE");
  });

  it("revisa cada sentencia por separado y recorta el texto mostrado", () => {
    const found = findDangers("SELECT 1; DELETE FROM a; UPDATE b SET x = 1 WHERE y = 2; DROP TABLE c");
    expect(found.map((d) => d.statement)).toEqual(["DELETE FROM a", "DROP TABLE c"]);
    expect(findDangers("DELETE FROM " + "x".repeat(300))[0].statement.length).toBeLessThanOrEqual(120);
    expect(findDangers("SELECT '😀'; DELETE FROM t")[0].statement).toBe("DELETE FROM t");
  });
});

describe("edición de datos en el visor", () => {
  async function openOrdersEditable(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));
    await user.dblClick(await screen.findByText("orders"));
    await screen.findByLabelText("Filtrar total");
  }

  const applied = () => calls.find((c) => c.cmd === "apply_changes")?.args.changes;

  it("con la sesión en solo lectura no se puede editar y se explica por qué", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    const button = screen.getByText("Editar datos").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("solo lectura");
  });

  it("edita una celda, revisa el SQL y aplica en una transacción", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);

    await user.click(screen.getByText("Editar datos"));
    await user.dblClick(screen.getByText("10"));
    const input = await screen.findByLabelText("Editar celda");
    await user.clear(input);
    await user.type(input, "11{Enter}");

    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();
    expect(screen.getByText("11")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "apply_changes")).toBe(false);

    await user.click(screen.getByText("Revisar y aplicar…"));
    expect(await screen.findByText(/UPDATE "public"."orders"/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "apply_changes")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Aplicar cambios" }));
    await waitFor(() => expect(applied()).toBeTruthy());
    expect(applied()).toEqual({
      updates: [{ pk: { id: "1" }, original: { total: "10" }, set: { total: "11" } }],
      deletes: [],
      inserts: [],
    });
    expect(await screen.findByText(/Cambios aplicados en una transacción/)).toBeTruthy();
    expect(screen.queryByText(/cambio pendiente/)).toBeNull();
  });

  it("las columnas boolean se editan con una lista true / false / NULL", async () => {
    readOnlyState = false;
    boolColumn = true;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));

    await user.dblClick(screen.getByText("t"));
    const select = (await screen.findByLabelText("Editar celda")) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("true");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["true", "false", "NULL"]);

    await user.selectOptions(select, "false");
    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();

    await user.dblClick(screen.getByText("false"));
    await user.selectOptions(await screen.findByLabelText("Editar celda"), "null");
    expect(await screen.findByText("NULL")).toBeTruthy();

    await user.dblClick(screen.getByText("NULL"));
    await user.selectOptions(await screen.findByLabelText("Editar celda"), "true");
    expect(screen.queryByText(/cambio pendiente/)).toBeNull();

    await user.dblClick(screen.getAllByText("t").find((el) => el.tagName === "TD")!);
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Editar celda")).toBeNull();
  });

  it("volver a escribir el valor original no deja cambios pendientes", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));
    await user.dblClick(screen.getByText("10"));
    const input = await screen.findByLabelText("Editar celda");
    await user.clear(input);
    await user.type(input, "10{Enter}");
    expect(screen.queryByText(/cambio pendiente/)).toBeNull();
  });

  it("Escape cancela la edición y las columnas de clave primaria no se editan", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));

    await user.dblClick(screen.getByText("10"));
    await user.type(await screen.findByLabelText("Editar celda"), "999{Escape}");
    expect(screen.queryByLabelText("Editar celda")).toBeNull();
    expect(screen.queryByText(/cambio pendiente/)).toBeNull();

    const pkCell = screen.getAllByText("1").find((el) => el.tagName === "TD" && !el.classList.contains("rownum"))!;
    await user.dblClick(pkCell);
    expect(screen.queryByLabelText("Editar celda")).toBeNull();
  });

  it("marca filas para eliminar y las envía solo al aplicar", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));

    await user.click(screen.getByTitle(/seleccionar fila/));
    await user.click(await screen.findByText("Marcar para eliminar"));
    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "apply_changes")).toBe(false);

    await user.click(screen.getByText("Revisar y aplicar…"));
    await screen.findByText(/UPDATE "public"."orders"/);
    await user.click(screen.getByRole("button", { name: "Aplicar cambios" }));
    await waitFor(() => expect(applied()).toBeTruthy());
    expect(applied()).toEqual({ updates: [], deletes: [{ pk: { id: "1" } }], inserts: [] });
  });

  it("añade una fila nueva y envía solo las columnas que se llenaron", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));

    await user.click(screen.getByText("Nueva fila"));
    await user.type(await screen.findByLabelText("Nuevo total"), "55");
    await user.click(screen.getAllByTitle("Poner NULL")[2]);
    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();

    await user.click(screen.getByText("Revisar y aplicar…"));
    await screen.findByText(/UPDATE "public"."orders"/);
    await user.click(screen.getByRole("button", { name: "Aplicar cambios" }));
    await waitFor(() => expect(applied()).toBeTruthy());
    expect(applied()).toEqual({
      updates: [],
      deletes: [],
      inserts: [{ values: { total: { mode: "value", value: "55" }, meta: { mode: "null" } } }],
    });
  });

  it("si el servidor rechaza los cambios muestra el motivo y conserva lo pendiente", async () => {
    readOnlyState = false;
    applyError = "Cambio 1 de 1: La fila ya no existe o cambió. No se aplicó ningún cambio.";
    const user = userEvent.setup();
    render(<App />);
    await openOrdersEditable(user);
    await user.click(screen.getByText("Editar datos"));
    await user.dblClick(screen.getByText("10"));
    const input = await screen.findByLabelText("Editar celda");
    await user.clear(input);
    await user.type(input, "12{Enter}");
    await user.click(screen.getByText("Revisar y aplicar…"));
    await screen.findByText(/UPDATE "public"."orders"/);
    await user.click(screen.getByRole("button", { name: "Aplicar cambios" }));

    expect(await screen.findByText(/No se aplicó ningún cambio/)).toBeTruthy();
    await user.click(screen.getByText("Cerrar", { selector: "button" }));
    expect(screen.getByText("1 cambio pendiente")).toBeTruthy();
  });
});

describe("seguridad en producción y en el editor SQL", () => {
  async function openSqlTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);
  }

  it("en producción habilitar escritura exige escribir el nombre de la base", async () => {
    productionProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await openSqlTab(user);
    expect((await screen.findAllByText("PRODUCCIÓN")).length).toBeGreaterThan(0);

    await user.click(screen.getByText("Solo lectura"));
    const confirm = await screen.findByRole("button", { name: "Habilitar escritura" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Nombre de la base para confirmar"), "postg");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Nombre de la base para confirmar"), "x");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText("Nombre de la base para confirmar"));
    await user.type(screen.getByLabelText("Nombre de la base para confirmar"), "postgres");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some((c) => c.cmd === "set_read_only")).toBe(false);

    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.cmd === "set_read_only")?.args.enabled).toBe(false));
    expect(calls.find((c) => c.cmd === "set_read_only")?.args.confirm).toBe("postgres");
  });

  async function loadDangerousStatement(user: ReturnType<typeof userEvent.setup>) {
    localStorage.setItem(
      "hyrax-history:p1",
      JSON.stringify([{ sql: "DELETE FROM orders", at: 1, ms: 1, ok: true }]),
    );
    readOnlyState = false;
    render(<App />);
    await openSqlTab(user);
    await user.click(await screen.findByText("Historial (1)"));
    await user.click(await screen.findByTitle("DELETE FROM orders"));
  }

  it("una sentencia peligrosa pide confirmación y se puede cancelar", async () => {
    const user = userEvent.setup();
    await loadDangerousStatement(user);
    await user.click(screen.getByText("Ejecutar"));

    expect(await screen.findByText("Sentencia peligrosa")).toBeTruthy();
    expect(screen.getByText(/DELETE sin WHERE/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "run_sql")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Sentencia peligrosa")).toBeNull();
    expect(calls.some((c) => c.cmd === "run_sql")).toBe(false);
  });

  it("desde el aviso se puede probar con ROLLBACK o ejecutar de todos modos", async () => {
    const user = userEvent.setup();
    await loadDangerousStatement(user);
    await user.click(screen.getByText("Ejecutar"));
    await user.click(await screen.findByRole("button", { name: "Probar con ROLLBACK" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "run_sql_dry")).toBe(true));
    expect(calls.find((c) => c.cmd === "run_sql_dry")?.args.sql).toBe("DELETE FROM orders");
    expect(calls.some((c) => c.cmd === "run_sql")).toBe(false);
    expect(await screen.findByText(/se revirtió \(ROLLBACK\)/)).toBeTruthy();

    await user.click(screen.getByText("Ejecutar"));
    await user.click(await screen.findByRole("button", { name: "Ejecutar de todos modos" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "run_sql")).toBe(true));
    expect(calls.find((c) => c.cmd === "run_sql")?.args.sql).toBe("DELETE FROM orders");
  });

  it("el botón de ensayo solo existe con la escritura habilitada", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSqlTab(user);
    expect(screen.queryByText("Probar (ROLLBACK)")).toBeNull();

    await user.click(await screen.findByText("Solo lectura"));
    await user.click(await screen.findByRole("button", { name: "Habilitar escritura" }));
    await user.click(await screen.findByText("Probar (ROLLBACK)"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "run_sql_dry")).toBe(true));
  });

  it("la escritura se desactiva sola a los 10 minutos", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<App />);
      await openSqlTab(user);
      await user.click(await screen.findByText("Solo lectura"));
      await user.click(await screen.findByRole("button", { name: "Habilitar escritura" }));
      await screen.findByText("Escritura habilitada");
      expect(calls.filter((c) => c.cmd === "set_read_only")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await waitFor(() => expect(calls.filter((c) => c.cmd === "set_read_only")).toHaveLength(2));
      expect(calls.filter((c) => c.cmd === "set_read_only")[1].args.enabled).toBe(true);
      expect(calls.filter((c) => c.cmd === "set_read_only")[0].args.confirm).toBeNull();
      expect(await screen.findByText(/se desactivó sola tras 10 minutos/)).toBeTruthy();
      expect(await screen.findByText("Solo lectura")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("credenciales, TLS e historial", () => {
  async function openEditDialog(user: ReturnType<typeof userEvent.setup>) {
    await inSidebar().findByText("dev_erp");
    await user.click(screen.getAllByTitle("Editar")[0]);
    await screen.findByText("Editar conexión");
  }

  it("la contraseña guardada nunca se muestra: solo se indica que existe y vacío la conserva", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditDialog(user);

    const password = screen.getByPlaceholderText("Guardada en el sistema (vacío = conservar)") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(document.body.innerHTML).not.toContain('value="x"');

    await user.click(screen.getByText("Guardar"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_profile")).toBe(true));
    const saved = calls.find((c) => c.cmd === "save_profile")?.args.profile as Record<string, unknown>;
    expect(saved.password).toBe("");
  });

  it("al verificar el certificado aparece el campo de la CA y al no verificar, un aviso", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditDialog(user);

    expect(screen.queryByLabelText(/Certificado de la CA/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("SSL"), "require");
    expect(await screen.findByText(/un intermediario podría suplantar/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("SSL"), "verify");
    const ca = await screen.findByLabelText(/Certificado de la CA/);
    expect(screen.queryByText(/un intermediario podría suplantar/)).toBeNull();
    await user.type(ca, "C:/certs/ca.pem");

    await user.click(screen.getByText("Guardar"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_profile")).toBe(true));
    const saved = calls.find((c) => c.cmd === "save_profile")?.args.profile as Record<string, unknown>;
    expect(saved.sslMode).toBe("verify");
    expect(saved.caCertPath).toBe("C:/certs/ca.pem");
  });

  async function openSqlEditor(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);
  }

  it("se puede desactivar el historial y entonces no se guarda nada", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSqlEditor(user);

    await user.click(await screen.findByText("Historial"));
    await user.click(screen.getByLabelText("Guardar historial"));
    await user.click(screen.getByText("Ejecutar"));
    await screen.findByText("Ejecutar");
    await waitFor(() => expect(calls.some((c) => c.cmd === "run_sql")).toBe(true));
    expect(screen.queryByText(/Historial \(\d+\)/)).toBeNull();
    expect(localStorage.getItem("hyrax-history:p1")).toBeNull();
    expect(localStorage.getItem("hyrax-history-enabled")).toBe("off");
  });

  it("en producción el límite de tiempo no ofrece la opción sin límite", async () => {
    productionProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await openSqlEditor(user);
    await screen.findByText("Límite");
    expect(screen.queryByRole("option", { name: "Sin límite" })).toBeNull();
    expect(screen.getByRole("option", { name: "5 min" })).toBeTruthy();
  });

  it("fuera de producción sí existe la opción sin límite", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openSqlEditor(user);
    expect(await screen.findByRole("option", { name: "Sin límite" })).toBeTruthy();
  });

  it("eliminar una conexión borra también su historial local", async () => {
    localStorage.setItem("hyrax-history:p1", JSON.stringify([{ sql: "SELECT 42", at: 1, ms: 1, ok: true }]));
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.click(screen.getAllByTitle("Eliminar")[0]);
    await user.click(await screen.findByText("Eliminar", { selector: "button.danger" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "delete_profile")).toBe(true));
    await waitFor(() => expect(localStorage.getItem("hyrax-history:p1")).toBeNull());
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function connectAndOpenOrders(user: User) {
  await user.click(await inSidebar().findByText("dev_erp"));
  await screen.findByText("erp_db");
  await user.click(await screen.findByText("erp_db"));
  await user.click(await screen.findByText("orders"));
  await user.dblClick(screen.getByText("orders"));
  await screen.findByText("Contar exacto");
}

function setEditor(text: string, cursor: number) {
  const dom = document.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom)!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
}

describe("etapa 9: navegar el esquema", () => {
  it("Ctrl+N abre la paleta de objetos, filtra y abre la tabla elegida", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");

    await user.keyboard("{Control>}n{/Control}");
    const search = await screen.findByRole("textbox", { name: "Ir a objeto" });
    await screen.findByText("order_total(id bigint)");
    await user.type(search, "tot");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const open = calls.filter((c) => c.cmd === "table_data").pop();
      expect(open?.args.table).toBe("totals");
    });
  });

  it("Ctrl+Enter en la paleta abre el DDL y una función siempre abre su DDL", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");

    await user.keyboard("{Control>}n{/Control}");
    await user.type(await screen.findByRole("textbox", { name: "Ir a objeto" }), "order_total");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const ddl = calls.filter((c) => c.cmd === "object_ddl").pop();
      expect(ddl?.args).toMatchObject({ name: "order_total", kind: "function", oid: 3 });
    });
    expect(await screen.findByText(/DDL de public\.order_total/)).toBeTruthy();
  });

  it("Ctrl+Mayús+A abre la paleta de comandos y ejecuta uno", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");

    await user.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
    await user.type(await screen.findByRole("textbox", { name: "Comandos" }), "nuevo editor");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Ejecutar todo")).toBeTruthy();
  });

  it("la pestaña Estructura muestra FKs, referencias, índices y estadísticas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(screen.getByText("Estructura"));

    expect(await screen.findByText("Claves foráneas (1)")).toBeTruthy();
    expect(screen.getByText("orders_total_fk")).toBeTruthy();
    expect(screen.getByText("public.totals (id)")).toBeTruthy();
    expect(screen.getByText("Referenciada por (1)")).toBeTruthy();
    expect(screen.getByText("public.order_items (order_id)")).toBeTruthy();
    expect(screen.getByText("Índices (1)")).toBeTruthy();
    expect(screen.getByText("monto")).toBeTruthy();
    expect(screen.getByText("16.0 KB")).toBeTruthy();
  });

  it("la pestaña DDL pide el DDL de la tabla", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(screen.getByText("DDL"));
    await waitFor(() => {
      const ddl = calls.filter((c) => c.cmd === "object_ddl").pop();
      expect(ddl?.args).toMatchObject({ schema: "public", name: "orders", kind: "table" });
    });
  });

  it("de una clave foránea se llega al registro relacionado con el filtro correcto", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);

    await user.click(await screen.findByLabelText("Ir al registro relacionado de total"));
    await waitFor(() => {
      const open = calls.filter((c) => c.cmd === "table_data").pop();
      expect(open?.args.table).toBe("totals");
      expect(open?.args.filters).toEqual([{ column: "id", op: "equals", value: "10" }]);
    });
    expect(await screen.findByDisplayValue("=10")).toBeTruthy();
  });

  it("desde una fila se ve quién la referencia y se abre esa tabla filtrada", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(await screen.findByTitle(/Clic: seleccionar fila/));

    const select = await screen.findByLabelText("Ir a los registros que referencian esta fila");
    await user.selectOptions(select, "0");
    await waitFor(() => {
      const open = calls.filter((c) => c.cmd === "table_data").pop();
      expect(open?.args.table).toBe("order_items");
      expect(open?.args.filters).toEqual([{ column: "order_id", op: "equals", value: "1" }]);
    });
  });
});

describe("etapa 10: consola SQL", () => {
  async function openEditor(user: User) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);
    await screen.findByText("Ejecutar todo");
  }

  const lastSql = () =>
    String(calls.filter((c) => c.cmd === "run_sql").pop()?.args.sql);

  it("Ejecutar corre solo la sentencia donde está el cursor y Ejecutar todo corre el script", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    const script = "SELECT 1;\n\nSELECT 2;\nSELECT 3;";
    setEditor(script, script.indexOf("SELECT 2") + 3);

    await user.click(screen.getByText("Ejecutar"));
    await waitFor(() => expect(lastSql()).toBe("SELECT 2;"));

    await user.click(screen.getByText("Ejecutar todo"));
    await waitFor(() => expect(lastSql()).toBe(script));
  });

  it("los parámetros :nombre piden valores y se envían como literales escapados", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    setEditor("SELECT * FROM orders WHERE id = :id AND note = :note", 5);

    await user.click(screen.getByText("Ejecutar"));
    const id = await screen.findByLabelText(":id");
    await user.type(id, "7");
    await user.type(screen.getByLabelText(":note"), "O'Brien");
    await user.click(within(screen.getByRole("dialog", { name: "Parámetros" })).getByText("Ejecutar"));

    await waitFor(() => expect(lastSql()).toBe("SELECT * FROM orders WHERE id = '7' AND note = 'O''Brien'"));
  });

  it("cancelar el diálogo de parámetros no ejecuta nada", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    setEditor("SELECT :x", 3);
    const before = calls.filter((c) => c.cmd === "run_sql").length;

    await user.click(screen.getByText("Ejecutar"));
    await screen.findByLabelText(":x");
    await user.click(screen.getByText("Cancelar"));
    expect(calls.filter((c) => c.cmd === "run_sql").length).toBe(before);
  });

  it("Explicar con JSON muestra el plan en árbol y resalta el nodo más costoso", async () => {
    planJson = true;
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    await user.click(screen.getByText("Explicar"));

    expect((await screen.findAllByText("Seq Scan en orders")).length).toBeGreaterThan(0);
    expect(screen.getByText("Index Scan en customers con customers_pkey")).toBeTruthy();
    const worst = await screen.findByText(/Nodo más costoso:/);
    expect(worst.textContent).toContain("Seq Scan en orders");
    expect(document.querySelector(".plan-node.hot")).not.toBeNull();
  });

  it("abre un script .sql en el editor y lo guarda con el nombre elegido", async () => {
    openedFile = { path: "C:/scripts/reporte.sql", name: "reporte.sql", content: "SELECT 42;" };
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);

    await user.click(screen.getByText("Abrir…"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_text_file")).toBe(true));
    await waitFor(() => {
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
      expect(view.state.doc.toString()).toBe("SELECT 42;");
    });
    expect(screen.getAllByText("reporte.sql").length).toBeGreaterThan(0);

    await user.click(screen.getByText("Guardar"));
    await waitFor(() => {
      const save = calls.filter((c) => c.cmd === "save_text_file").pop();
      expect(save?.args).toMatchObject({ content: "SELECT 42;", defaultName: "reporte.sql", path: "C:/scripts/reporte.sql" });
    });
  });
});

describe("etapa 11: datos avanzados", () => {
  it("la vista de fila muestra el JSON con formato y deja editar hacia los cambios pendientes", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(await screen.findByTitle(/Clic: seleccionar fila/));
    await user.click(await screen.findByText("Ver fila"));

    const meta = (await screen.findByLabelText(/^meta/)) as HTMLTextAreaElement;
    expect(meta.value).toBe('{\n  "a": {\n    "b": 2\n  }\n}');
    expect(screen.getByText("JSON")).toBeTruthy();
    expect((screen.getByLabelText(/^id/) as HTMLTextAreaElement).readOnly).toBe(true);

    await user.click(within(screen.getByRole("dialog", { name: "Fila como formulario" })).getByTitle("Cerrar"));
    expect(screen.queryByRole("dialog", { name: "Fila como formulario" })).toBeNull();
  });

  it("en modo edición la vista de fila añade el cambio a los pendientes", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(await screen.findByText("Editar datos"));
    await user.click(await screen.findByTitle(/Clic: seleccionar fila/));
    await user.click(await screen.findByText("Ver fila"));

    const total = (await screen.findByLabelText(/^total/)) as HTMLTextAreaElement;
    await user.clear(total);
    await user.type(total, "99");
    await user.click(screen.getByText("Añadir a cambios pendientes"));

    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();
  });

  it("importar: asigna columnas por nombre, ensaya con ROLLBACK e importa", async () => {
    readOnlyState = false;
    openedFile = { path: "C:/datos/pedidos.csv", name: "pedidos.csv", content: "id;total;nota\n1;10;x\n2;;y\n" };
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);

    await user.click(screen.getByText("Importar…"));
    await user.click(await screen.findByText("Elegir archivo…"));
    expect(await screen.findByText(/2 filas · 3 columnas/)).toBeTruthy();
    expect((screen.getByLabelText("Origen de id") as HTMLSelectElement).value).toBe("0");
    expect((screen.getByLabelText("Origen de total") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Origen de meta") as HTMLSelectElement).value).toBe("");

    await user.click(screen.getByText("Ensayar (ROLLBACK)"));
    await screen.findByText(/Ensayo correcto: se insertarían 2 filas/);
    const dry = calls.filter((c) => c.cmd === "import_rows").pop();
    expect(dry?.args).toMatchObject({
      schema: "public",
      table: "orders",
      columns: ["id", "total"],
      rows: [["1", "10"], ["2", null]],
      dryRun: true,
    });

    await user.click(screen.getByText("Importar 2 filas"));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "import_rows").pop()?.args.dryRun).toBe(false));
    expect(await screen.findByText(/Se importaron 2 filas en una sola transacción/)).toBeTruthy();
  });

  it("importar muestra el error del servidor con el número de fila", async () => {
    readOnlyState = false;
    importError = "Fila 2: ERROR: invalid input syntax for type integer\nNo se importó nada.";
    openedFile = { path: "C:/datos/p.json", name: "p.json", content: '[{"id":1,"total":"x"},{"id":2}]' };
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);

    await user.click(screen.getByText("Importar…"));
    await user.click(await screen.findByText("Elegir archivo…"));
    await user.click(await screen.findByText("Ensayar (ROLLBACK)"));
    expect(await screen.findByText(/Fila 2: ERROR/)).toBeTruthy();
  });

  it("importar exige escritura habilitada", async () => {
    openedFile = { path: "C:/datos/p.csv", name: "p.csv", content: "id\n1\n" };
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);
    await user.click(screen.getByText("Importar…"));
    await user.click(await screen.findByText("Elegir archivo…"));
    await screen.findByText(/solo lectura: habilita la escritura para ensayar o importar/);
    expect((screen.getByText("Ensayar (ROLLBACK)") as HTMLButtonElement).disabled).toBe(true);
  });

  it("fijar dos resultados y compararlos muestra añadidas, eliminadas y modificadas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);

    await user.click(screen.getByText("Fijar"));
    await screen.findByText(/Resultado fijado/);
    await user.click(screen.getByText("Fijar"));
    await user.click(await screen.findByText(/Comparar \(2\)/));

    expect(await screen.findByText("Comparar resultados")).toBeTruthy();
    expect(screen.getByText(/1 iguales/)).toBeTruthy();
    expect(screen.getByText(/0 añadidas/)).toBeTruthy();
  });

  it("la edición sigue disponible con filtros activos y los cambios pendientes sobreviven al filtro", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await connectAndOpenOrders(user);

    await user.type(await screen.findByLabelText("Filtrar total"), ">5");
    await waitFor(() => {
      const last = calls.filter((c) => c.cmd === "table_data").pop();
      expect(last?.args.filters).toEqual([{ column: "total", op: "gt", value: "5" }]);
    });
    const edit = screen.getByText("Editar datos").closest("button") as HTMLButtonElement;
    expect(edit.disabled).toBe(false);
    await user.click(edit);

    await user.dblClick(await screen.findByText("10"));
    const input = await screen.findByLabelText("Editar celda");
    await user.clear(input);
    await user.type(input, "11{Enter}");
    expect(await screen.findByText("1 cambio pendiente")).toBeTruthy();

    await user.click(screen.getByText(/Limpiar filtros/));
    await waitFor(() => {
      const last = calls.filter((c) => c.cmd === "table_data").pop();
      expect(last?.args.filters).toEqual([]);
    });
    expect(screen.getByText("1 cambio pendiente")).toBeTruthy();
  });

  it("la rejilla virtualizada solo dibuja las filas visibles de un resultado grande", async () => {
    const user = userEvent.setup();
    const { default: ResultGrid } = await import("./components/ResultGrid");
    const rows = Array.from({ length: 5000 }, (_, i) => [String(i + 1), `fila ${i + 1}`]);
    render(
      <ResultGrid
        result={{ columns: ["id", "texto"], rows, totalRows: 5000, truncated: false, totalIsLowerBound: false, affected: null }}
      />,
    );
    const rendered = document.querySelectorAll("tbody tr:not(.spacer-row)").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(120);
    expect(document.querySelector(".spacer-row")).not.toBeNull();
    expect(screen.queryByText("fila 4000")).toBeNull();
    void user;
  });

  it("un resultado pequeño no se virtualiza", async () => {
    const { default: ResultGrid } = await import("./components/ResultGrid");
    const rows = Array.from({ length: 50 }, (_, i) => [String(i + 1)]);
    render(
      <ResultGrid
        result={{ columns: ["id"], rows, totalRows: 50, truncated: false, totalIsLowerBound: false, affected: null }}
      />,
    );
    expect(document.querySelectorAll("tbody tr").length).toBe(50);
    expect(document.querySelector(".spacer-row")).toBeNull();
  });
});

describe("menú contextual y eliminar", () => {
  async function showOrders(user: User) {
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(await screen.findByText("erp_db"));
    return screen.findByText("orders");
  }

  const dialog = () => screen.getByRole("dialog", { name: "Confirmar eliminación" });
  const dropButton = () => within(dialog()).getByRole("button", { name: "Eliminar" }) as HTMLButtonElement;

  it("clic derecho en una tabla ofrece las acciones, y Escape cierra el menú", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));

    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(labels).toEqual(["Abrir datos", "Ver DDL", "Nueva consulta SELECT", "Copiar nombre", "Eliminar tabla…"]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Nueva consulta SELECT» abre un editor con la consulta lista", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));
    await user.click(await screen.findByRole("menuitem", { name: /Nueva consulta SELECT/ }));

    await screen.findByText("Ejecutar todo");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe('SELECT *\nFROM "public"."orders"\nLIMIT 100;');
  });

  it("eliminar una tabla exige habilitar la escritura y escribir su nombre exacto", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar tabla/ }));

    expect(dropButton().disabled).toBe(true);
    expect(within(dialog()).getByText(/La escritura está deshabilitada/)).toBeTruthy();
    expect(within(dialog()).getByText('DROP TABLE "public"."orders";')).toBeTruthy();

    await user.click(within(dialog()).getByText("Habilitar escritura"));
    await waitFor(() => expect(within(dialog()).queryByText(/La escritura está deshabilitada/)).toBeNull());
    expect(dropButton().disabled).toBe(true);

    const input = within(dialog()).getByLabelText("Escribe el nombre para confirmar");
    await user.type(input, "Orders");
    expect(dropButton().disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "orders");
    expect(dropButton().disabled).toBe(false);

    const before = calls.filter((c) => c.cmd === "list_relations").length;
    await user.click(dropButton());
    await waitFor(() => {
      const drop = calls.filter((c) => c.cmd === "drop_object").pop();
      expect(drop?.args).toEqual({
        id: "p1::erp_db",
        schema: "public",
        name: "orders",
        kind: "table",
        cascade: false,
        confirm: "orders",
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirmar eliminación" })).toBeNull());
    expect(calls.filter((c) => c.cmd === "list_relations").length).toBeGreaterThan(before);
  });

  it("CASCADE se pide aparte y se ve en el SQL antes de ejecutar", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar tabla/ }));

    await user.click(within(dialog()).getByRole("checkbox"));
    expect(within(dialog()).getByText('DROP TABLE "public"."orders" CASCADE;')).toBeTruthy();
    await user.type(within(dialog()).getByLabelText("Escribe el nombre para confirmar"), "orders");
    await user.click(dropButton());
    await waitFor(() => expect(calls.filter((c) => c.cmd === "drop_object").pop()?.args.cascade).toBe(true));
  });

  it("si el servidor rechaza la eliminación, el diálogo sigue abierto con el error", async () => {
    readOnlyState = false;
    dropError = 'ERROR: cannot drop table orders because other objects depend on it';
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar tabla/ }));
    await user.type(within(dialog()).getByLabelText("Escribe el nombre para confirmar"), "orders");
    await user.click(dropButton());

    expect(await within(dialog()).findByText(/other objects depend on it/)).toBeTruthy();
    expect(dropButton().disabled).toBe(false);
  });

  it("en producción, habilitar la escritura desde el diálogo pide el nombre de la base", async () => {
    productionProfile = true;
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(await showOrders(user));
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar tabla/ }));

    const enable = within(dialog()).getByText("Habilitar escritura") as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    await user.type(within(dialog()).getByLabelText("Nombre de la base erp_db"), "erp_db");
    expect(enable.disabled).toBe(false);
    await user.click(enable);
    await waitFor(() => {
      const set = calls.filter((c) => c.cmd === "set_read_only").pop();
      expect(set?.args).toMatchObject({ id: "p1::erp_db", enabled: false, confirm: "erp_db" });
    });
  });

  it("eliminar una base de datos pide el nombre y la saca del árbol", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    fireEvent.contextMenu(await screen.findByText("erp_db"));
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar base de datos/ }));

    expect(within(dialog()).getByText('DROP DATABASE "erp_db";')).toBeTruthy();
    expect(dropButton().disabled).toBe(true);
    await user.type(within(dialog()).getByLabelText("Escribe el nombre para confirmar"), "erp_db");
    await user.click(dropButton());

    await waitFor(() => {
      const drop = calls.filter((c) => c.cmd === "drop_database").pop();
      expect(drop?.args).toEqual({ id: "p1", database: "erp_db", force: false, confirm: "erp_db" });
    });
    await waitFor(() => expect(screen.queryByText("erp_db")).toBeNull());
    expect(await screen.findByText("Base de datos erp_db eliminada.")).toBeTruthy();
  });

  it("eliminar una tabla cierra sus pestañas abiertas", async () => {
    readOnlyState = false;
    const user = userEvent.setup();
    render(<App />);
    const orders = await showOrders(user);
    await user.dblClick(orders);
    await screen.findByText("Contar exacto");
    fireEvent.contextMenu(screen.getAllByText("orders")[0]);
    await user.click(await screen.findByRole("menuitem", { name: /Eliminar tabla/ }));
    await user.type(within(dialog()).getByLabelText("Escribe el nombre para confirmar"), "orders");
    await user.click(dropButton());

    await waitFor(() => expect(screen.queryByText("Contar exacto")).toBeNull());
  });
});

describe("borrar conexiones y contraseñas guardadas", () => {
  const openReset = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
    await user.type(await screen.findByRole("textbox", { name: "Comandos" }), "borrar conexiones");
    await user.keyboard("{Enter}");
    return await screen.findByRole("dialog", { name: "Borrar datos guardados" });
  };

  it("exige escribir BORRAR y luego deja la lista de conexiones vacía", async () => {
    const user = userEvent.setup();
    localStorage.setItem("hyrax-history:p1", JSON.stringify([{ sql: "select 1", at: 1, ms: 1, ok: true }]));
    render(<App />);
    await inSidebar().findByText("dev_erp");

    const dialog = await openReset(user);
    const confirm = within(dialog).getByRole("button", { name: "Borrar todo" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(calls.some((c) => c.cmd === "reset_app_data")).toBe(false);

    await user.type(within(dialog).getByRole("textbox", { name: "Escribe BORRAR para confirmar" }), "borrar");
    expect(confirm.disabled).toBe(true); // es sensible a mayúsculas

    await user.clear(within(dialog).getByRole("textbox", { name: "Escribe BORRAR para confirmar" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Escribe BORRAR para confirmar" }), "BORRAR");
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);

    await waitFor(() => expect(calls.find((c) => c.cmd === "reset_app_data")?.args).toEqual({ confirm: "BORRAR" }));
    await waitFor(() => expect(inSidebar().queryByText("dev_erp")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Borrar datos guardados" })).toBeNull();
    expect(localStorage.getItem("hyrax-history:p1")).toBeNull();
  });

  it("conserva el historial si se desmarca la opción, y cancelar no borra nada", async () => {
    const user = userEvent.setup();
    localStorage.setItem("hyrax-history:p1", JSON.stringify([{ sql: "select 1", at: 1, ms: 1, ok: true }]));
    render(<App />);
    await inSidebar().findByText("dev_erp");

    let dialog = await openReset(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(calls.some((c) => c.cmd === "reset_app_data")).toBe(false);
    expect(inSidebar().getByText("dev_erp")).toBeTruthy();

    dialog = await openReset(user);
    await user.click(within(dialog).getByRole("checkbox"));
    await user.type(within(dialog).getByRole("textbox", { name: "Escribe BORRAR para confirmar" }), "BORRAR");
    await user.click(within(dialog).getByRole("button", { name: "Borrar todo" }));
    await waitFor(() => expect(inSidebar().queryByText("dev_erp")).toBeNull());
    expect(localStorage.getItem("hyrax-history:p1")).not.toBeNull();
    localStorage.removeItem("hyrax-history:p1");
  });
});

describe("conexión por motor", () => {
  const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.click(screen.getByTitle("Nueva conexión"));
    return await screen.findByRole("radiogroup", { name: "Motor" });
  };

  it("al crear se elige el motor; PostgreSQL es el predeterminado y MongoDB cambia los campos", async () => {
    const user = userEvent.setup();
    const picker = await openNew(user);
    const pg = within(picker).getByRole("radio", { name: "PostgreSQL" });
    const mongo = within(picker).getByRole("radio", { name: "MongoDB" });
    expect(pg.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Conectar por un túnel SSH")).toBeTruthy();

    await user.click(mongo);
    expect(mongo.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Base de autenticación")).toBeTruthy();
    expect(screen.getByText("Base de datos (opcional)")).toBeTruthy();
    expect(screen.queryByText("Conectar por un túnel SSH")).toBeNull();
    expect((screen.getByLabelText(/^Puerto/) as HTMLInputElement).value).toBe("27017");
  });

  it("pegar una cadena mongodb+srv avisa de que no está soportada", async () => {
    const user = userEvent.setup();
    await openNew(user);
    const box = screen.getByPlaceholderText(/postgresql:\/\/usuario:clave@host:5432/);
    fireEvent.paste(box, { clipboardData: { getData: () => "mongodb+srv://ana:s3@c.example.net/ventas" } });
    expect(await screen.findByText(/mongodb\+srv:\/\/ no están soportadas/)).toBeTruthy();
  });

  it("pegar una cadena mongodb cambia el motor y rellena los campos; Probar y Guardar mandan engine mongodb", async () => {
    const user = userEvent.setup();
    await openNew(user);
    const box = screen.getByPlaceholderText(/postgresql:\/\/usuario:clave@host:5432/);
    fireEvent.paste(box, {
      clipboardData: { getData: () => "mongodb://ana:s3@mongo.example.com:27017/ventas?authSource=admin&tls=true" },
    });

    expect(await screen.findByText(/Cadena aplicada\./)).toBeTruthy();
    expect(within(screen.getByRole("radiogroup", { name: "Motor" })).getByRole("radio", { name: "MongoDB" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("mongo.example.com");

    await user.click(screen.getByText("Probar"));
    expect(await screen.findByText("MongoDB 8.0.3")).toBeTruthy();
    const tested = calls.filter((c) => c.cmd === "test_connection").pop();
    expect(tested?.args.profile).toMatchObject({
      engine: "mongodb",
      host: "mongo.example.com",
      user: "ana",
      sslMode: "verify",
      mongo: { authSource: "admin" },
    });

    await user.click(screen.getByText("Guardar"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_profile")).toBe(true));
    const saved = calls.filter((c) => c.cmd === "save_profile").pop();
    expect(saved?.args.profile).toMatchObject({ engine: "mongodb", database: "ventas" });
  });

  it("al editar una conexión no se puede cambiar el motor ni pegar una cadena de otro", async () => {
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.hover(inSidebar().getByText("dev_erp"));
    await user.click(screen.getByTitle("Editar"));
    await screen.findByText("Editar conexión");
    expect(screen.queryByRole("radiogroup", { name: "Motor" })).toBeNull();

    fireEvent.paste(screen.getByPlaceholderText(/postgresql:\/\/usuario:clave@host:5432/), {
      clipboardData: { getData: () => "mongodb://h/db" },
    });
    expect(await screen.findByText(/es de PostgreSQL; la cadena es de otro motor/)).toBeTruthy();
  });
});

describe("pantalla de inicio", () => {
  it("lista las conexiones con su motor y los botones de nueva conexión por motor", async () => {
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    const start = await screen.findByRole("button", { name: /Conectar con mongo_demo/ });
    expect(within(start).getByText("MongoDB")).toBeTruthy();
    const pg = screen.getByRole("button", { name: /Conectar con dev_erp/ });
    expect(within(pg).getByText("PostgreSQL")).toBeTruthy();
    expect(within(pg).getByText("u@h")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Nueva conexión MongoDB/ }));
    const picker = await screen.findByRole("radiogroup", { name: "Motor" });
    expect(within(picker).getByRole("radio", { name: "MongoDB" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText(/^Puerto/) as HTMLInputElement).value).toBe("27017");
  });

  it("Nueva conexión PostgreSQL abre el formulario de PostgreSQL", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Nueva conexión PostgreSQL/ }));
    const picker = await screen.findByRole("radiogroup", { name: "Motor" });
    expect(within(picker).getByRole("radio", { name: "PostgreSQL" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText(/^Puerto/) as HTMLInputElement).value).toBe("5432");
  });

  it("abrir una conexión desde el inicio la conecta y la deja como reciente", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con dev_erp/ }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "connect_profile" && c.args.id === "p1")).toBe(true));
    expect(JSON.parse(localStorage.getItem("hyrax-recent") ?? "[]")).toEqual(["p1"]);
  });

  it("las recientes van primero", async () => {
    withMongoProfile = true;
    localStorage.setItem("hyrax-recent", JSON.stringify(["m1"]));
    render(<App />);
    await screen.findByRole("button", { name: /Conectar con dev_erp/ });
    const names = screen.getAllByRole("button", { name: /^Conectar con / }).map((b) => b.getAttribute("title"));
    expect(names).toEqual(["Conectar con mongo_demo", "Conectar con dev_erp"]);
  });
});

describe("MongoDB: explorar", () => {
  const openCollection = async (user: ReturnType<typeof userEvent.setup>) => {
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");
  };

  it("oculta las bases del sistema (admin, config, local) y deja mostrarlas", async () => {
    withMongoProfile = true;
    mongoSystemDbs = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));

    expect(await inSidebar().findByText("ventas")).toBeTruthy();
    expect(inSidebar().queryByText("admin")).toBeNull();
    expect(inSidebar().queryByText("config")).toBeNull();
    expect(inSidebar().queryByText("local")).toBeNull();

    await user.click(inSidebar().getByText("Mostrar bases del sistema (3)"));
    expect(inSidebar().getByText("admin")).toBeTruthy();
    expect(inSidebar().getByText("config")).toBeTruthy();
    expect(inSidebar().getByText("local")).toBeTruthy();

    await user.click(inSidebar().getByText("Ocultar bases del sistema"));
    expect(inSidebar().queryByText("admin")).toBeNull();
  });

  it("conectar desde el inicio abre la sesión y lista bases y colecciones", async () => {
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));

    expect(await inSidebar().findByText("ventas")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "mongo_connect" && c.args.id === "m1")).toBe(true);
    expect(calls.some((c) => c.cmd === "connect_profile")).toBe(false);
    expect(JSON.parse(localStorage.getItem("hyrax-recent") ?? "[]")).toEqual(["m1"]);

    await user.click(inSidebar().getByText("ventas"));
    expect(await inSidebar().findByText("orders")).toBeTruthy();
    expect(inSidebar().getByText("open_orders")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "mongo_list_collections")?.args).toEqual({ id: "m1", database: "ventas" });
  });

  it("abrir una colección muestra sus documentos con los tipos resumidos y pide la primera página", async () => {
    const user = userEvent.setup();
    await openCollection(user);

    expect(screen.getByText("507f1f77bcf86cd799439011")).toBeTruthy(); // ObjectId como texto
    expect(screen.getByText("Beto")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy(); // Int32 sin el envoltorio
    expect(screen.getByText('{ city: "Lima" }')).toBeTruthy();
    const find = calls.filter((c) => c.cmd === "mongo_find").pop();
    expect(find?.args).toMatchObject({
      id: "m1",
      database: "ventas",
      collection: "orders",
      filter: "",
      sort: "",
      projection: "",
      skip: 0,
      limit: 51,
    });
    expect(await screen.findByText(/≈ 3 documentos \(estimado\)/)).toBeTruthy();
    expect(await screen.findByText("1–3 de ≈ 3")).toBeTruthy();
  });

  it("el filtro rápido se convierte en JSON, vuelve a la primera página y valida antes de enviar", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    const before = calls.filter((c) => c.cmd === "mongo_find").length;

    await user.type(screen.getByRole("textbox", { name: "Filtro" }), "age>30 name~be{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mongo_find").length).toBe(before + 1));
    const sent = calls.filter((c) => c.cmd === "mongo_find").pop();
    expect(JSON.parse(String(sent?.args.filter))).toEqual({ age: { $gt: 30 }, name: { $regex: "be", $options: "i" } });

    await user.clear(screen.getByRole("textbox", { name: "Filtro" }));
    await user.type(screen.getByRole("textbox", { name: "Filtro" }), "esto no se entiende{Enter}");
    expect(await screen.findByText(/No entiendo/)).toBeTruthy();
    expect(calls.filter((c) => c.cmd === "mongo_find").length).toBe(before + 1); // no se envió nada
  });

  it("orden y campos se envían como JSON", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    await user.click(screen.getByRole("button", { name: "Orden y campos" }));
    await user.type(screen.getByRole("textbox", { name: "Orden" }), "-age");
    await user.type(screen.getByRole("textbox", { name: "Campos" }), "name -_id");
    await user.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => {
      const sent = calls.filter((c) => c.cmd === "mongo_find").pop();
      expect(sent?.args.sort).toBe('{"age":-1}');
      expect(sent?.args.projection).toBe('{"name":1,"_id":0}');
    });
  });

  it("el visor de documento muestra el árbol con los tipos BSON", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    const row = screen.getByText("Ana").closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[0]); // número de fila: selecciona la fila
    await user.click(await screen.findByRole("button", { name: "Ver documento" }));

    const viewer = await screen.findByRole("complementary", { name: "Documento" });
    expect(within(viewer).getByText("ObjectId")).toBeTruthy();
    expect(within(viewer).getAllByText("int").length).toBeGreaterThan(0);
    expect(within(viewer).getByText('"Ana"')).toBeTruthy();
    expect(within(viewer).getByText("addr")).toBeTruthy();
    expect(within(viewer).getByText('"Lima"')).toBeTruthy();
  });

  it("Contar exacto usa el filtro aplicado", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    await user.type(screen.getByRole("textbox", { name: "Filtro" }), "age>20{Enter}");
    await user.click(await screen.findByRole("button", { name: "Contar exacto" }));
    expect(await screen.findByText(/2 documentos con el filtro/)).toBeTruthy();
    expect(calls.filter((c) => c.cmd === "mongo_count").pop()?.args).toMatchObject({
      id: "m1",
      collection: "orders",
      filter: '{"age":{"$gt":20}}',
    });
  });

  it("un error del servidor se muestra en la pestaña", async () => {
    mongoFindError = "MongoDB: Operation exceeded time limit";
    const user = userEvent.setup();
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    expect(await screen.findByText(/Operation exceeded time limit/)).toBeTruthy();
  });

  it("si falla la conexión muestra el aviso y no abre el árbol", async () => {
    mongoConnectError = "No se pudo conectar con MongoDB: Server selection timeout";
    const user = userEvent.setup();
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    expect(await screen.findByText(/No se pudo conectar: .*Server selection timeout/)).toBeTruthy();
    expect(inSidebar().queryByText("ventas")).toBeNull();
  });

  it("PostgreSQL y MongoDB pueden estar conectados a la vez, cada uno con su árbol", async () => {
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con dev_erp/ }));
    await inSidebar().findByText("erp_db");
    await user.click(inSidebar().getByText("mongo_demo"));
    await inSidebar().findByText("ventas");

    // Los dos árboles siguen abiertos y cada motor usó sus propios comandos.
    expect(inSidebar().getByText("erp_db")).toBeTruthy();
    expect(inSidebar().getByText("ventas")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "connect_profile" && c.args.id === "p1")).toBe(true);
    expect(calls.some((c) => c.cmd === "mongo_connect" && c.args.id === "m1")).toBe(true);

    // Desconectar uno no cierra el otro.
    await user.click(inSidebar().getAllByTitle("Desconectar")[1]);
    await waitFor(() => expect(inSidebar().queryByText("ventas")).toBeNull());
    expect(inSidebar().getByText("erp_db")).toBeTruthy();
  });

  it("desconectar cierra el árbol de la conexión", async () => {
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await inSidebar().findByText("ventas");
    await user.click(inSidebar().getByTitle("Desconectar"));
    await waitFor(() => expect(inSidebar().queryByText("ventas")).toBeNull());
    expect(calls.some((c) => c.cmd === "disconnect_profile" && c.args.id === "m1")).toBe(true);
  });
});

describe("vista JSON de MongoDB", () => {
  const openCollection = async (user: ReturnType<typeof userEvent.setup>) => {
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");
  };

  it("la colección alterna entre tabla y una lista de documentos en JSON legible", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    const view = screen.getByRole("group", { name: "Vista" });
    expect(within(view).getByRole("button", { name: "Tabla" }).className).toContain("active");

    await user.click(within(view).getByRole("button", { name: "JSON" }));
    const list = await screen.findByLabelText("Documentos en JSON");
    // Los números salen como números, no como {"$numberInt":"30"}; los tipos sin equivalente en JSON se conservan.
    expect(list.textContent).toContain('"name": "Ana"');
    expect(list.textContent).toContain('"age": 30');
    expect(list.textContent).toContain('"$oid": "507f1f77bcf86cd799439011"');
    expect(list.textContent).not.toContain("$numberInt");
    expect(within(list).getAllByRole("button", { name: /Copiar/ })).toHaveLength(3);
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(within(view).getByRole("button", { name: "Tabla" }));
    expect(await screen.findByText("Beto")).toBeTruthy();
    expect(screen.queryByLabelText("Documentos en JSON")).toBeNull();
  });

  it("el visor de un documento alterna entre árbol y JSON", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    const row = screen.getByText("Ana").closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[0]);
    await user.click(await screen.findByRole("button", { name: "Ver documento" }));

    const viewer = await screen.findByRole("complementary", { name: "Documento" });
    expect(within(viewer).getByText("ObjectId")).toBeTruthy(); // árbol por omisión

    await user.click(within(viewer).getByRole("button", { name: "JSON" }));
    expect(viewer.textContent).toContain('"city": "Lima"');
    expect(viewer.textContent).toContain('"age": 30');
    expect(within(viewer).queryByText("ObjectId")).toBeNull();

    await user.click(within(viewer).getByRole("button", { name: "Árbol" }));
    expect(within(viewer).getByText("ObjectId")).toBeTruthy();
  });
});

describe("MongoDB: autocompletado de la búsqueda", () => {
  const openCollection = async (user: ReturnType<typeof userEvent.setup>) => {
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");
    return screen.getByRole("textbox", { name: "Filtro" }) as HTMLInputElement;
  };
  const options = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");

  it("sugiere campos al escribir, incluidos los anidados, y los acepta con el teclado", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);

    await user.type(filter, "ag");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(options()[0]).toContain("age");

    await user.keyboard("{ArrowDown}{Tab}");
    expect(filter.value).toBe("age=");

    // Tras aceptar el campo aparecen enseguida los valores vistos.
    await waitFor(() => expect(options().some((o) => o.startsWith("41"))).toBe(true));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(filter.value).toBe("age=41");
    // Y esa Enter solo aceptó la sugerencia: no lanzó la búsqueda.
    expect(calls.filter((c) => c.cmd === "mongo_find").length).toBe(1);
  });

  it("encuentra campos anidados por lo que se escribe", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);
    await user.type(filter, "cit");
    await screen.findByRole("listbox");
    expect(options().some((o) => o.startsWith("addr.city"))).toBe(true);
  });

  it("con un campo completo ofrece los operadores, y con el operador, los valores", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);
    await user.type(filter, "age");
    await screen.findByRole("listbox");
    expect(options().some((o) => o.startsWith("age >") && o.includes("mayor que"))).toBe(true);

    await user.type(filter, ">");
    await waitFor(() => expect(options().some((o) => o.startsWith("30"))).toBe(true));
  });

  it("Esc cierra la lista, Ctrl+Espacio la abre y Enter sin elegir lanza la búsqueda", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);
    await user.type(filter, "na");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.clear(filter);
    await user.click(filter);
    await user.keyboard("{Control>} {/Control}");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(options()[0]).toContain("_id");
    await user.keyboard("{Escape}");

    await user.type(filter, "name=Ana{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mongo_find").length).toBe(2));
    expect(JSON.parse(String(calls.filter((c) => c.cmd === "mongo_find").pop()?.args.filter))).toEqual({ name: "Ana" });
  });

  it("se puede elegir con el ratón y el campo conserva el foco", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);
    await user.type(filter, "nam");
    const option = (await screen.findAllByRole("option")).find((o) => (o.textContent ?? "").startsWith("name"))!;
    await user.click(option);
    expect(filter.value).toBe("name=");
    expect(document.activeElement).toBe(filter);
  });

  it("también ayuda en el JSON y en el orden", async () => {
    const user = userEvent.setup();
    const filter = await openCollection(user);
    await user.type(filter, '{{ "ag');
    await screen.findByRole("listbox");
    await user.keyboard("{Tab}");
    expect(filter.value).toBe('{ "age"');

    await user.clear(filter);
    await user.click(screen.getByRole("button", { name: "Orden y campos" }));
    const sort = screen.getByRole("textbox", { name: "Orden" }) as HTMLInputElement;
    await user.type(sort, "-na");
    await screen.findByRole("listbox");
    await user.keyboard("{Tab}");
    expect(sort.value).toBe("-name");
  });
});

describe("vista de documentos al estilo mongosh", () => {
  const openCollection = async (user: ReturnType<typeof userEvent.setup>) => {
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");
  };

  it("la vista Documentos muestra ObjectId('…') y claves sin comillas, como Compass", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    await user.click(within(screen.getByRole("group", { name: "Vista" })).getByRole("button", { name: "Documentos" }));
    const list = await screen.findByLabelText("Lista de documentos");
    expect(list.textContent).toContain("_id: ObjectId('507f1f77bcf86cd799439011')");
    expect(list.textContent).toContain('name: "Ana"');
    expect(list.textContent).toContain("age: 30");
    expect(list.textContent).toContain("addr: {");
    expect(list.textContent).not.toContain("$oid");
    expect(within(list).getAllByRole("button", { name: /Copiar/ })).toHaveLength(3);
  });

  it("el visor tiene Árbol, Documento y JSON", async () => {
    const user = userEvent.setup();
    await openCollection(user);
    const row = screen.getByText("Ana").closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[0]);
    await user.click(await screen.findByRole("button", { name: "Ver documento" }));
    const viewer = await screen.findByRole("complementary", { name: "Documento" });

    await user.click(within(viewer).getByRole("button", { name: "Documento" }));
    expect(viewer.textContent).toContain("_id: ObjectId('507f1f77bcf86cd799439011')");
    expect(viewer.textContent).toContain('city: "Lima"');

    await user.click(within(viewer).getByRole("button", { name: "JSON" }));
    expect(viewer.textContent).toContain('"$oid": "507f1f77bcf86cd799439011"');
  });
});

describe("MongoDB: formato por omisión y preferencia", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    withMongoProfile = true;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
  };

  it("sin preferencia guardada abre la lista de documentos al estilo mongosh y el visor en modo Documento", async () => {
    localStorage.removeItem("hyrax-mongo-view");
    localStorage.removeItem("hyrax-mongo-viewer");
    const user = userEvent.setup();
    await open(user);

    const list = await screen.findByLabelText("Lista de documentos");
    expect(list.textContent).toContain("_id: ObjectId('507f1f77bcf86cd799439011')");
    expect(within(screen.getByRole("group", { name: "Vista" })).getByRole("button", { name: "Documentos" }).className).toContain("active");

    // El visor se abre desde la tabla (que tiene selección de filas) y arranca en «Documento».
    await user.click(within(screen.getByRole("group", { name: "Vista" })).getByRole("button", { name: "Tabla" }));
    const row = (await screen.findByText("Ana")).closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[0]);
    await user.click(await screen.findByRole("button", { name: "Ver documento" }));
    const viewer = await screen.findByRole("complementary", { name: "Documento" });
    expect(within(viewer).getByRole("button", { name: "Documento" }).className).toContain("active");
    expect(viewer.textContent).toContain("ObjectId('507f1f77bcf86cd799439011')");
  });

  it("recuerda la vista elegida al abrir otra colección", async () => {
    localStorage.removeItem("hyrax-mongo-view");
    const user = userEvent.setup();
    await open(user);
    await screen.findByLabelText("Lista de documentos");
    await user.click(within(screen.getByRole("group", { name: "Vista" })).getByRole("button", { name: "JSON" }));
    expect(localStorage.getItem("hyrax-mongo-view")).toBe("json");

    cleanup();
    await open(userEvent.setup());
    const list = await screen.findByLabelText("Documentos en JSON");
    expect(list.textContent).toContain('"$oid"');
  });

  it("si el almacenamiento falla usa el valor por omisión sin romperse", async () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith("hyrax-mongo-")) throw new Error("sin acceso");
      return original.call(this, key);
    };
    try {
      const user = userEvent.setup();
      await open(user);
      expect(await screen.findByLabelText("Lista de documentos")).toBeTruthy();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("ajustes e idioma", () => {
  it("el botón de ajustes abre el diálogo y cambiar el idioma se aplica al instante y se recuerda", async () => {
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");

    await user.click(inSidebar().getByRole("button", { name: "Ajustes" }));
    const dialog = await screen.findByRole("dialog", { name: "Ajustes" });
    expect(within(dialog).getByRole("heading", { name: "Ajustes" })).toBeTruthy();

    await user.selectOptions(within(dialog).getByLabelText("Idioma"), "en");
    expect(getLang()).toBe("en");
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(localStorage.getItem("hyrax-lang")).toBe("en");

    await user.selectOptions(screen.getByLabelText("Language"), "es");
    expect(await screen.findByRole("dialog", { name: "Ajustes" })).toBeTruthy();
    expect(localStorage.getItem("hyrax-lang")).toBe("es");
  });

  it("desde los ajustes se cambia el tema y se llega a borrar los datos guardados", async () => {
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.click(inSidebar().getByRole("button", { name: "Ajustes" }));
    const dialog = await screen.findByRole("dialog", { name: "Ajustes" });

    await user.click(within(dialog).getByRole("button", { name: "Oscuro" }));
    expect(localStorage.getItem("hyrax-theme")).toBe("dark");
    await user.click(within(dialog).getByRole("button", { name: "Claro" }));
    expect(localStorage.getItem("hyrax-theme")).toBe("light");

    await user.click(within(dialog).getByRole("button", { name: /Borrar conexiones y contraseñas guardadas/ }));
    expect(screen.queryByRole("dialog", { name: "Ajustes" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Borrar datos guardados" })).toBeTruthy();
  });

  it("Cerrar cierra el diálogo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.click(inSidebar().getByRole("button", { name: "Ajustes" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Ajustes" })).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog", { name: "Ajustes" })).toBeNull();
  });
});

describe("interfaz en inglés", () => {
  const SPANISH = /[áéíóúñ¿¡]/;
  const noSpanish = (el: HTMLElement | Element) => {
    const found = (el.textContent ?? "").match(/.{0,30}[áéíóúñ¿¡].{0,30}/g);
    expect(found, "texto en español en la interfaz en inglés").toBeNull();
    expect(SPANISH.test(el.textContent ?? "")).toBe(false);
  };
  const attrs = (root: ParentNode) =>
    [...root.querySelectorAll("[title],[aria-label],[placeholder]")]
      .flatMap((e) => [e.getAttribute("title"), e.getAttribute("aria-label"), e.getAttribute("placeholder")])
      .filter((v): v is string => !!v);

  it("la pantalla de inicio y la barra lateral salen en inglés, sin acentos del español", async () => {
    setLang("en");
    withMongoProfile = true;
    render(<App />);
    expect(await screen.findByText("Desktop database client")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New PostgreSQL connection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New MongoDB connection" })).toBeTruthy();
    expect(screen.getByText("Connections")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect to mongo_demo" })).toBeTruthy();
    expect(screen.getByText(/New connections open in read-only mode\./)).toBeTruthy();
    noSpanish(document.body);
    expect(attrs(document.body).filter((a) => SPANISH.test(a))).toEqual([]);
  });

  it("el formulario de conexión de MongoDB sale en inglés", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "New MongoDB connection" }));
    const dialog = await screen.findByRole("radiogroup", { name: "Engine" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Authentication database")).toBeTruthy();
    expect(screen.getByText("Database (optional)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    const modal = document.querySelector(".modal") as HTMLElement;
    noSpanish(modal);
    expect(attrs(modal).filter((a) => SPANISH.test(a))).toEqual([]);
  });

  it("el formulario de conexión de PostgreSQL con túnel SSH sale en inglés", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "New PostgreSQL connection" }));
    await user.click(screen.getByLabelText(/Connect through an SSH tunnel/));
    expect(screen.getByText("SSH host")).toBeTruthy();
    expect(screen.getByText(/Press “Test” to see the server's fingerprint/)).toBeTruthy();
    noSpanish(document.querySelector(".modal") as HTMLElement);
  });

  it("la colección de MongoDB sale en inglés: vistas, filtro, sugerencias y visor", async () => {
    setLang("en");
    localStorage.setItem("hyrax-mongo-view", "table");
    localStorage.setItem("hyrax-mongo-viewer", "doc");
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Connect to mongo_demo" }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");

    const view = screen.getByRole("group", { name: "View" });
    expect(within(view).getByRole("button", { name: "Documents" })).toBeTruthy();
    expect(within(view).getByRole("button", { name: "Table" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exact count" })).toBeTruthy();
    expect(screen.getByText(/≈ 3 documents \(estimated\)/)).toBeTruthy();

    // sugerencias
    await user.type(screen.getByRole("textbox", { name: "Filter" }), "age");
    const list = await screen.findByRole("listbox");
    expect(list.textContent).toContain("greater than");
    await user.keyboard("{Escape}");

    // visor
    const row = screen.getByText("Ana").closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[0]);
    await user.click(await screen.findByRole("button", { name: "View document" }));
    const viewer = await screen.findByRole("complementary", { name: "Document" });
    expect(within(viewer).getByRole("button", { name: "Tree" })).toBeTruthy();
    noSpanish(document.body);
    expect(attrs(document.body).filter((a) => SPANISH.test(a))).toEqual([]);
  });

  it("una consulta de MongoDB mal escrita da el error en inglés", async () => {
    setLang("en");
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Connect to mongo_demo" }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    await screen.findByText("Ana");
    await user.type(screen.getByRole("textbox", { name: "Filter" }), "this makes no sense{Enter}");
    expect(await screen.findByText(/I do not understand “this makes no sense”/)).toBeTruthy();
  });

  it("los ajustes cambian el idioma de toda la aplicación sin recargar", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Connections");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.selectOptions(within(dialog).getByLabelText("Language"), "es");
    // el diálogo y la pantalla de inicio de detrás cambian al instante
    expect(await screen.findByRole("dialog", { name: "Ajustes" })).toBeTruthy();
    expect(screen.getByText("Conexiones")).toBeTruthy();
    expect(screen.getByText("Cliente de bases de datos de escritorio")).toBeTruthy();
    expect(getLang()).toBe("es");
  });

  it("borrar los datos guardados pide ERASE en inglés y el backend lo recibe tal cual", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await inSidebar().findByText("dev_erp");
    await user.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
    await user.type(await screen.findByRole("textbox", { name: "Commands" }), "erase saved");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Erase saved data" });
    noSpanish(dialog);
    const confirm = within(dialog).getByRole("button", { name: "Erase everything" }) as HTMLButtonElement;
    const input = within(dialog).getByRole("textbox", { name: "Type ERASE to confirm" });
    await user.type(input, "BORRAR");
    expect(confirm.disabled).toBe(true); // la palabra es la del idioma actual
    await user.clear(input);
    await user.type(input, "ERASE");
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.cmd === "reset_app_data")?.args).toEqual({ confirm: "ERASE" }));
  });
});

describe("interfaz en inglés: PostgreSQL", () => {
  const SPANISH = /[áéíóúñ¿¡]/;
  const check = (label: string, root: ParentNode = document.body) => {
    const text = (root as HTMLElement).textContent ?? "";
    const found = text.match(/.{0,40}[áéíóúñ¿¡].{0,40}/g);
    if (found) throw new Error(`${label}: texto en español → ${found.join(" || ")}`);
    const attrs = [...root.querySelectorAll("[title],[aria-label],[placeholder]")]
      .flatMap((e) => [e.getAttribute("title"), e.getAttribute("aria-label"), e.getAttribute("placeholder")])
      .filter((v): v is string => !!v && SPANISH.test(v));
    expect(attrs, `${label}: atributos en español`).toEqual([]);
  };

  it("la tabla, su estructura, el DDL, el editor SQL, la importación y el borrado salen en inglés", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(await screen.findByText("erp_db"));
    await user.click(await screen.findByText("orders"));
    await user.dblClick(screen.getByText("orders"));
    await screen.findByText("Exact count");
    check("tabla");

    await user.click(screen.getByText("Structure"));
    await screen.findByText(/Foreign keys \(1\)/);
    check("estructura");

    await user.click(screen.getByText("DDL"));
    await screen.findByText("Open in SQL editor");
    check("DDL");

    await user.click(screen.getByText("Data"));
    await user.click(await screen.findByText("Import…"));
    const importDialog = await screen.findByRole("dialog", { name: "Import data" });
    check("importar", importDialog);
    await user.click(within(importDialog).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: /SQL$/ }));
    await screen.findByText("Run all");
    check("editor SQL");
  });

  it("el menú contextual y el diálogo de eliminar salen en inglés", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(await screen.findByText("erp_db"));
    fireEvent.contextMenu(await screen.findByText("orders"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "Open data",
      "View DDL",
      "New SELECT query",
      "Copy name",
      "Drop table…",
    ]);
    check("menú", menu);
    await user.click(within(menu).getByRole("menuitem", { name: /Drop table/ }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm deletion" });
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    expect(within(dialog).getByText("Will run:")).toBeTruthy();
    check("eliminar", dialog);
  });

  it("el chip de modo y la confirmación de escritura salen en inglés", async () => {
    setLang("en");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await inSidebar().findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(await screen.findByText("erp_db"));
    await user.dblClick(await screen.findByText("orders"));
    await screen.findByText("Exact count");
    await user.click(screen.getAllByRole("button", { name: /Read-only/ })[0]);
    const dialog = document.querySelector(".modal") as HTMLElement;
    expect(within(dialog).getByText(/You are about to allow writes on/)).toBeTruthy();
    check("modo escritura", dialog);
  });
});

describe("errores del backend en inglés", () => {
  it("un error de conexión que llega en español de Rust se muestra en inglés", async () => {
    setLang("en");
    mongoConnectError = "No se pudo conectar con MongoDB: Server selection timeout";
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Connect to mongo_demo" }));
    expect(await screen.findByText("Could not connect: Could not connect to MongoDB: Server selection timeout")).toBeTruthy();
  });

  it("el error de una consulta de MongoDB mantiene el detalle del servidor y traduce la plantilla", async () => {
    setLang("en");
    mongoFindError = "El nombre de la colección no es válido.";
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Connect to mongo_demo" }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    expect(await screen.findByText("The collection name is not valid.")).toBeTruthy();
  });

  it("en español el mensaje queda como lo manda el backend", async () => {
    mongoFindError = "El nombre de la colección no es válido.";
    withMongoProfile = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Conectar con mongo_demo/ }));
    await user.click(await inSidebar().findByText("ventas"));
    await user.dblClick(await inSidebar().findByText("orders"));
    expect(await screen.findByText("El nombre de la colección no es válido.")).toBeTruthy();
  });
});
