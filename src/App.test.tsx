// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let holdRuns = false;
let saveResult: string | null = "C:/tmp/export.csv";
let failDatabases = false;
let readOnlyState = true;
let pendingRun: { resolve: (v: unknown) => void } | null = null;
const calls: { cmd: string; args: Record<string, unknown> }[] = [];

const profile = {
  id: "p1",
  name: "dev_erp",
  host: "h",
  port: 5432,
  database: "postgres",
  user: "u",
  password: "x",
  sslMode: "disable",
  readOnly: true,
};

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => saveResult),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_profiles":
        return [profile];
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
            columns: ["id", "total"],
            rows: [["1", "10"]],
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
      case "completion_schema":
        return [{ schema: "public", table: "orders", columns: ["id", "total"] }];
      case "run_sql": {
        if (holdRuns) {
          return new Promise((resolve) => {
            pendingRun = { resolve };
          });
        }
        const text = String(args.sql);
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
        return [{ name: "id", dataType: "bigint", nullable: false, default: null, isPrimaryKey: true }];
      default:
        throw new Error("comando no simulado: " + cmd);
    }
  }),
}));

import { format as formatSql } from "sql-formatter";
import { parseFilter } from "./filters";
import App from "./App";

const emptyRects = Object.assign([], { item: () => null });
Range.prototype.getClientRects = () => emptyRects as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

beforeEach(() => {
  calls.length = 0;
  failDatabases = false;
  readOnlyState = true;
  holdRuns = false;
  saveResult = "C:/tmp/export.csv";
  pendingRun = null;
  localStorage.clear();
});
afterEach(cleanup);

describe("navegador", () => {
  it("al abrir el servidor lista sus bases de datos", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("dev_erp"));

    expect(await screen.findByText("erp_db")).toBeTruthy();
    expect(await screen.findByText("postgres")).toBeTruthy();
    expect(await screen.findByText("public")).toBeTruthy();
  });

  it("un segundo clic mientras conecta no cierra el servidor", async () => {
    const user = userEvent.setup();
    render(<App />);
    const row = await screen.findByText("dev_erp");
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
    await user.click(await screen.findByText("dev_erp"));

    expect(await screen.findByText(/permiso denegado/)).toBeTruthy();
    expect(screen.queryByText("Cargando…")).toBeNull();
  });

  it("reintenta cargar las bases al reabrir un servidor ya conectado", async () => {
    failDatabases = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("dev_erp"));
    await screen.findByText(/permiso denegado/);

    failDatabases = false;
    await user.click(screen.getByText("dev_erp"));
    expect(await screen.findByText("erp_db")).toBeTruthy();
    expect(screen.queryByText(/permiso denegado/)).toBeNull();
  });

  it("al abrir otra base muestra sus tablas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("dev_erp"));
    await user.click(await screen.findByText("erp_db"));

    await waitFor(() => expect(calls.some((c) => c.cmd === "connect_profile" && c.args.database === "erp_db")).toBe(true));
    const publics = await screen.findAllByText("public");
    await user.click(publics[publics.length - 1]);
    expect(await screen.findByText("orders")).toBeTruthy();
  });

  it("el editor SQL abre en solo lectura y pide confirmación para habilitar escritura", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);

    const chip = await screen.findByText("Solo lectura", { selector: "button *, button" });
    await user.click(chip);
    expect(await screen.findByText(/Vas a permitir escrituras/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "set_read_only")).toBe(false);

    await user.click(screen.getByText("Habilitar escritura"));
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
    await user.click(await screen.findByText("dev_erp"));
    await screen.findByText("erp_db");
    await user.click(screen.getAllByTitle("Nuevo editor SQL")[0]);

    await user.click(await screen.findByText("Ejecutar"));
    const cancel = await screen.findByText("Cancelar");
    await user.click(cancel);

    await waitFor(() => expect(calls.some((c) => c.cmd === "cancel_query")).toBe(true));
    expect(await screen.findByText("Ejecutar")).toBeTruthy();
  });

  async function openSql(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByText("dev_erp"));
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
    expect(sent[sent.length - 1]).toBe("EXPLAIN SELECT 1");
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
    await user.click(await screen.findByText("Habilitar escritura"));
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
    await user.click(await screen.findByText("dev_erp"));
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
    await user.click(await screen.findByText("dev_erp"));
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
    await user.click(await screen.findByText("dev_erp"));
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
    await user.click(await screen.findByText("dev_erp"));
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
