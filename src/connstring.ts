import type { ConnectionProfile, Engine, MongoSettings } from "./api";
import { t } from "./i18n";

export interface ParsedConnection {
  fields: Partial<Pick<ConnectionProfile, "host" | "port" | "database" | "user" | "password" | "sslMode" | "caCertPath">>;
  notes: string[];
}

/** Lee una cadena `postgresql://usuario:clave@host:5432/base?sslmode=verify-full`. Lanza Error con un mensaje legible. */
export function parseConnectionString(raw: string): ParsedConnection {
  const text = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(text)) {
    throw new Error(t("La cadena debe empezar por postgresql:// o postgres://"));
  }
  let url: URL;
  try {
    // Un esquema que no es especial (postgresql://) conserva el puerto tal cual, también el 80.
    url = new URL(text);
  } catch {
    throw new Error(t("La cadena de conexión no es válida."));
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new Error(t("La cadena tiene caracteres mal codificados (usa %40 para @, %3A para :)."));
    }
  };

  const fields: ParsedConnection["fields"] = {};
  const notes: string[] = [];

  if (url.hostname) fields.host = decode(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("El puerto no es válido."));
    fields.port = port;
  }
  if (url.username) fields.user = decode(url.username);
  if (url.password) fields.password = decode(url.password);
  const database = decode(url.pathname.replace(/^\//, ""));
  if (database) fields.database = database;

  const mode = url.searchParams.get("sslmode")?.toLowerCase();
  if (mode === "disable") fields.sslMode = "disable";
  else if (mode === "require") fields.sslMode = "require";
  else if (mode === "verify-ca" || mode === "verify-full") fields.sslMode = "verify";
  else if (mode === "prefer" || mode === "allow") {
    notes.push(t("sslmode={mode} no existe en Hyrax; elige el cifrado a mano.", { mode }));
  } else if (mode) {
    throw new Error(t("sslmode={mode} no es un valor conocido.", { mode }));
  } else {
    notes.push(t("La cadena no indica sslmode; revisa el cifrado."));
  }
  const root = url.searchParams.get("sslrootcert");
  if (root) fields.caCertPath = root;

  if (!fields.host) {
    throw new Error(t("Falta el host. Hyrax se conecta por TCP: no admite sockets Unix ni cadenas sin host (postgresql:///base)."));
  }
  return { fields, notes };
}

/** Deduce el motor por el esquema de la cadena, o null si no es ninguno conocido. */
export function detectEngine(raw: string): Engine | null {
  const text = raw.trim();
  if (/^postgres(ql)?:\/\//i.test(text)) return "postgres";
  if (/^mongodb(\+srv)?:\/\//i.test(text)) return "mongodb";
  return null;
}

export interface ParsedMongo {
  fields: Partial<Pick<ConnectionProfile, "host" | "port" | "database" | "user" | "password" | "sslMode" | "caCertPath">>;
  mongo: MongoSettings;
  notes: string[];
}

const KNOWN_MONGO_PARAMS = new Set([
  "replicaset",
  "authsource",
  "directconnection",
  "tls",
  "ssl",
  "tlsallowinvalidcertificates",
  "tlscafile",
]);

/**
 * Lee `mongodb://usuario:clave@host1:27017,host2:27017/base?replicaSet=rs0&authSource=admin&tls=true`
 * y `mongodb+srv://…`. Lanza Error con un mensaje legible. Los parámetros que Hyrax no usa se avisan, no se
 * aplican en silencio.
 */
export function parseMongoUri(raw: string): ParsedMongo {
  const text = raw.trim();
  const m = text.match(/^mongodb(\+srv)?:\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i);
  if (!m) throw new Error(t("La cadena debe tener la forma mongodb://usuario:clave@host:27017/base o mongodb+srv://…"));
  const srv = !!m[1];
  const [, , userinfo, hostsRaw, dbRaw, queryRaw] = m;

  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new Error(t("La cadena tiene caracteres mal codificados (usa %40 para @, %3A para :)."));
    }
  };

  const fields: ParsedMongo["fields"] = {};
  const mongo: MongoSettings = { srv, extraHosts: "", authSource: null, replicaSet: null, directConnection: false };
  const notes: string[] = [];

  if (userinfo !== undefined) {
    const i = userinfo.indexOf(":");
    const user = i < 0 ? userinfo : userinfo.slice(0, i);
    const pass = i < 0 ? "" : userinfo.slice(i + 1);
    if (/[@/]/.test(pass) || /[@/]/.test(user)) throw new Error(t("El usuario y la contraseña deben ir codificados (usa %40 para @, %2F para /)."));
    if (user) fields.user = decode(user);
    if (pass) fields.password = decode(pass);
  }

  if (hostsRaw.includes("@")) throw new Error(t("El usuario y la contraseña deben ir codificados (usa %40 para @, %2F para /)."));
  const hosts = hostsRaw.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) throw new Error(t("Falta el host."));
  const parseHost = (entry: string): { host: string; port: number | null } => {
    const mm = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!mm) throw new Error(t("El host «{host}» no es válido.", { host: entry }));
    const port = mm[2] ? Number(mm[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) throw new Error(t("El puerto no es válido."));
    return { host: mm[1], port };
  };
  const first = parseHost(hosts[0]);
  fields.host = first.host;
  if (srv) {
    if (hosts.length > 1 || first.port !== null) throw new Error(t("Con mongodb+srv el host va solo, sin puerto ni otros nodos."));
  } else {
    fields.port = first.port ?? 27017;
    mongo.extraHosts = hosts
      .slice(1)
      .map((h) => {
        parseHost(h);
        return h;
      })
      .join(",");
  }
  if (dbRaw) fields.database = decode(dbRaw);

  const params = new Map<string, string>();
  const ignored: string[] = [];
  for (const pair of (queryRaw ?? "").split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));
    const value = decode(eq < 0 ? "" : pair.slice(eq + 1));
    if (KNOWN_MONGO_PARAMS.has(key.toLowerCase())) params.set(key.toLowerCase(), value);
    else ignored.push(key);
  }
  if (ignored.length > 0) notes.push(t("Se ignoraron estos parámetros: {list}.", { list: ignored.join(", ") }));

  if (params.get("replicaset")) mongo.replicaSet = params.get("replicaset")!;
  if (params.get("authsource")) mongo.authSource = params.get("authsource")!;
  if (params.get("directconnection")?.toLowerCase() === "true") mongo.directConnection = true;

  const tls = (params.get("tls") ?? params.get("ssl"))?.toLowerCase();
  if (tls === "false") fields.sslMode = "disable";
  else if (params.get("tlsallowinvalidcertificates")?.toLowerCase() === "true") fields.sslMode = "require";
  else if (tls === "true" || srv) fields.sslMode = "verify";
  else {
    fields.sslMode = "disable";
    notes.push(t("La cadena no activa TLS; revisa el cifrado si el servidor lo exige."));
  }
  if (params.get("tlscafile")) fields.caCertPath = params.get("tlscafile")!;
  if (mongo.directConnection && srv) throw new Error(t("directConnection no se puede usar con mongodb+srv."));

  return { fields, mongo, notes };
}
