import { invoke } from "@tauri-apps/api/core";
import { translateBackend } from "./i18n/backend";

export type SslMode = "disable" | "require" | "verify";

export interface SshSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string | null;
  fingerprint: string | null;
  /** Frase de la clave o contraseña SSH: solo viaja al guardar o probar; se guarda en el almacén del sistema. */
  secret: string;
  hasSecret: boolean;
  /** Pide olvidar el secreto guardado (vacío sin esto = conservar). */
  clearSecret: boolean;
}

export const noSsh = (): SshSettings => ({
  enabled: false,
  host: "",
  port: 22,
  user: "",
  keyPath: null,
  fingerprint: null,
  secret: "",
  hasSecret: false,
  clearSecret: false,
});

export type Engine = "postgres" | "mongodb";

export interface MongoSettings {
  /** Otros nodos del conjunto de réplicas, separados por comas. */
  extraHosts: string;
  /** Base donde se autentica el usuario (vacío = admin). */
  authSource: string | null;
  replicaSet: string | null;
  directConnection: boolean;
}

export const noMongo = (): MongoSettings => ({
  extraHosts: "",
  authSource: null,
  replicaSet: null,
  directConnection: false,
});

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
  production: boolean;
  caCertPath: string | null;
  hasPassword: boolean;
  ssh: SshSettings;
  engine: Engine;
  mongo: MongoSettings;
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

export interface SortKey {
  column: string;
  descending: boolean;
}

export interface RowUpdate {
  pk: Record<string, string>;
  original: Record<string, string | null>;
  set: Record<string, string | null>;
}

export interface RowDelete {
  pk: Record<string, string>;
}

export type InsertValue = { mode: "default" } | { mode: "null" } | { mode: "value"; value: string };

export interface RowInsert {
  values: Record<string, InsertValue>;
}

export interface ChangeSet {
  updates: RowUpdate[];
  deletes: RowDelete[];
  inserts: RowInsert[];
}

export interface ApplyResult {
  updated: number;
  deleted: number;
  inserted: number;
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

export type ObjectKind = RelationKind | "sequence" | "function" | "procedure";

export interface ObjectRef {
  schema: string;
  name: string;
  kind: ObjectKind;
  detail: string | null;
  oid: number;
}

export interface StructColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  identity: string | null;
  generated: boolean;
  collation: string | null;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  definition: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  sizeBytes: number;
  backsConstraint: boolean;
}

export interface ConstraintInfo {
  name: string;
  kind: "primary" | "unique" | "foreign" | "check" | "exclusion";
  definition: string;
  validated: boolean;
}

export interface ForeignKey {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TriggerInfo {
  name: string;
  definition: string;
  enabled: boolean;
}

export interface TableStats {
  estimatedRows: number | null;
  totalBytes: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
  deadTuples: number | null;
  lastVacuum: string | null;
  lastAnalyze: string | null;
  seqScans: number | null;
  idxScans: number | null;
}

export interface TableStructure {
  kind: RelationKind;
  comment: string | null;
  columns: StructColumn[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  foreignKeys: ForeignKey[];
  referencedBy: ForeignKey[];
  triggers: TriggerInfo[];
  stats: TableStats;
}

export interface ImportResult {
  inserted: number;
  rolledBack: boolean;
}

export interface FileContent {
  path: string;
  name: string;
  content: string;
}

export interface MongoDatabase {
  name: string;
  sizeOnDisk: number | null;
  empty: boolean;
}

export interface MongoCollection {
  name: string;
  kind: "collection" | "view" | "timeseries";
}

export interface MongoPage {
  /** Cada documento como JSON extendido canónico. */
  documents: string[];
  truncated: boolean;
  elapsedMs: number;
}

export interface MongoConnectInfo {
  version: string;
  readOnly: boolean;
}

export const api = {
  mongoConnect: (id: string) => invoke<MongoConnectInfo>("mongo_connect", { id }),
  mongoDisconnect: (id: string) => invoke<void>("mongo_disconnect", { id }),
  mongoListDatabases: (id: string) => invoke<MongoDatabase[]>("mongo_list_databases", { id }),
  mongoListCollections: (id: string, database: string) =>
    invoke<MongoCollection[]>("mongo_list_collections", { id, database }),
  mongoFind: (
    id: string,
    database: string,
    collection: string,
    filter: string,
    sort: string,
    projection: string,
    skip: number,
    limit: number,
    timeoutMs = 0,
  ) => invoke<MongoPage>("mongo_find", { id, database, collection, filter, sort, projection, skip, limit, timeoutMs }),
  mongoCount: (id: string, database: string, collection: string, filter: string, timeoutMs = 0) =>
    invoke<number>("mongo_count", { id, database, collection, filter, timeoutMs }),
  mongoEstimatedCount: (id: string, database: string, collection: string) =>
    invoke<number>("mongo_estimated_count", { id, database, collection }),
  dropObject: (id: string, schema: string, name: string, kind: RelationKind, cascade: boolean, confirm: string) =>
    invoke<string>("drop_object", { id, schema, name, kind, cascade, confirm }),
  dropDatabase: (id: string, database: string, force: boolean, confirm: string) =>
    invoke<string>("drop_database", { id, database, force, confirm }),
  searchObjects: (id: string) => invoke<ObjectRef[]>("search_objects", { id }),
  tableStructure: (id: string, schema: string, table: string) =>
    invoke<TableStructure>("table_structure", { id, schema, table }),
  objectDdl: (id: string, schema: string, name: string, kind: ObjectKind, oid: number | null) =>
    invoke<string>("object_ddl", { id, schema, name, kind, oid }),
  completionFks: (id: string) => invoke<ForeignKey[]>("completion_fks", { id }),
  importRows: (
    id: string,
    schema: string,
    table: string,
    columns: string[],
    rows: (string | null)[][],
    dryRun: boolean,
  ) => invoke<ImportResult>("import_rows", { id, schema, table, columns, rows, dryRun }),
  openTextFile: (kind: "sql" | "data") => invoke<FileContent | null>("open_text_file", { kind }),
  saveTextFile: (content: string, defaultName: string, path: string | null) =>
    invoke<FileContent | null>("save_text_file", { content, defaultName, path }),
  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),
  saveProfile: (profile: ConnectionProfile) => invoke<void>("save_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  resetAppData: (confirm: string) => invoke<number>("reset_app_data", { confirm }),
  testConnection: (profile: ConnectionProfile) => invoke<string>("test_connection", { profile }),
  connect: (id: string, database: string) =>
    invoke<SessionInfo>("connect_profile", { id, database }),
  setReadOnly: (id: string, enabled: boolean, confirm?: string) =>
    invoke<boolean>("set_read_only", { id, enabled, confirm: confirm ?? null }),
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
    order: SortKey[],
  ) => invoke<TablePage>("table_data", { id, schema, table, limit, offset, filters, order }),
  countRows: (id: string, schema: string, table: string, filters: ColumnFilter[]) =>
    invoke<number>("count_rows", { id, schema, table, filters }),
  exportTable: (
    id: string,
    schema: string,
    table: string,
    filters: ColumnFilter[],
    order: SortKey[],
    format: ExportFormat,
    path: string,
  ) => invoke<ExportResult>("export_table", { id, schema, table, filters, order, format, path }),
  previewChanges: (id: string, schema: string, table: string, changes: ChangeSet) =>
    invoke<string[]>("preview_changes", { id, schema, table, changes }),
  applyChanges: (id: string, schema: string, table: string, changes: ChangeSet) =>
    invoke<ApplyResult>("apply_changes", { id, schema, table, changes }),
  runSqlDry: (id: string, sql: string, limit: number, timeoutMs: number) =>
    invoke<QueryOutput>("run_sql_dry", { id, sql, limit, timeoutMs }),
  exportSql: (id: string, sql: string, format: ExportFormat, path: string) =>
    invoke<ExportResult>("export_sql", { id, sql, format, path }),
  runSql: (id: string, sql: string, limit: number, timeoutMs: number) =>
    invoke<QueryOutput>("run_sql", { id, sql, limit, timeoutMs }),
};

export function errorText(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  // Los errores del backend vienen en español: en inglés se traducen aquí.
  return translateBackend(text);
}

export const sessionKey = (profileId: string, database: string) => `${profileId}::${database}`;

export const profileOfSession = (key: string) => key.split("::")[0];

export const databaseOfSession = (key: string) => key.slice(key.indexOf("::") + 2);
