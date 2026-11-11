import { invoke } from "@tauri-apps/api/core";

export type SslMode = "disable" | "require";

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
  readOnly: boolean;
}

export interface SessionInfo {
  version: string;
  readOnly: boolean;
}

export interface SchemaInfo {
  name: string;
  isSystem: boolean;
}

export interface CompletionTable {
  schema: string;
  table: string;
  columns: string[];
}

export type RelationKind = "table" | "view" | "matview" | "foreign";

export interface RelationInfo {
  name: string;
  kind: RelationKind;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

export interface ResultSet {
  columns: string[];
  rows: (string | null)[][];
  totalRows: number;
  truncated: boolean;
  totalIsLowerBound: boolean;
  affected: number | null;
}

export type FilterOp =
  | "contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_null"
  | "not_null";

export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value: string | null;
}

export type ExportFormat = "csv" | "json" | "sql";

export interface ExportResult {
  rows: number;
}

export interface QueryOutput {
  results: ResultSet[];
  elapsedMs: number;
}

export interface TablePage {
  result: ResultSet;
  estimatedRows: number | null;
  elapsedMs: number;
}

export const api = {
  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),
  saveProfile: (profile: ConnectionProfile) => invoke<void>("save_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  testConnection: (profile: ConnectionProfile) => invoke<string>("test_connection", { profile }),
  connect: (id: string, database: string) =>
    invoke<SessionInfo>("connect_profile", { id, database }),
  setReadOnly: (id: string, enabled: boolean) => invoke<boolean>("set_read_only", { id, enabled }),
  cancelQuery: (id: string) => invoke<void>("cancel_query", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  disconnectProfile: (id: string) => invoke<void>("disconnect_profile", { id }),
  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),
  completionSchema: (id: string) => invoke<CompletionTable[]>("completion_schema", { id }),
  listSchemas: (id: string) => invoke<SchemaInfo[]>("list_schemas", { id }),
  listRelations: (id: string, schema: string) =>
    invoke<RelationInfo[]>("list_relations", { id, schema }),
  listColumns: (id: string, schema: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, schema, table }),
  tableData: (
    id: string,
    schema: string,
    table: string,
    limit: number,
    offset: number,
    filters: ColumnFilter[],
    orderBy: string | null,
    descending: boolean,
  ) =>
    invoke<TablePage>("table_data", { id, schema, table, limit, offset, filters, orderBy, descending }),
  countRows: (id: string, schema: string, table: string, filters: ColumnFilter[]) =>
    invoke<number>("count_rows", { id, schema, table, filters }),
  exportTable: (
    id: string,
    schema: string,
    table: string,
    filters: ColumnFilter[],
    orderBy: string | null,
    descending: boolean,
    format: ExportFormat,
    path: string,
  ) =>
    invoke<ExportResult>("export_table", { id, schema, table, filters, orderBy, descending, format, path }),
  exportSql: (id: string, sql: string, format: ExportFormat, path: string) =>
    invoke<ExportResult>("export_sql", { id, sql, format, path }),
  runSql: (id: string, sql: string, limit: number, timeoutMs: number) =>
    invoke<QueryOutput>("run_sql", { id, sql, limit, timeoutMs }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export const sessionKey = (profileId: string, database: string) => `${profileId}::${database}`;

export const profileOfSession = (key: string) => key.split("::")[0];

export const databaseOfSession = (key: string) => key.slice(key.indexOf("::") + 2);
