import type { ConnectionProfile } from "./api";

export interface ParsedConnection {
  fields: Partial<Pick<ConnectionProfile, "host" | "port" | "database" | "user" | "password" | "sslMode" | "caCertPath">>;
  notes: string[];
}

/** Lee una cadena `postgresql://usuario:clave@host:5432/base?sslmode=verify-full`. Lanza Error con un mensaje legible. */
export function parseConnectionString(raw: string): ParsedConnection {
  const text = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(text)) {
    throw new Error("La cadena debe empezar por postgresql:// o postgres://");
  }
  let url: URL;
  try {
    // Un esquema que no es especial (postgresql://) conserva el puerto tal cual, también el 80.
    url = new URL(text);
  } catch {
    throw new Error("La cadena de conexión no es válida.");
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new Error("La cadena tiene caracteres mal codificados (usa %40 para @, %3A para :).");
    }
  };

  const fields: ParsedConnection["fields"] = {};
  const notes: string[] = [];

  if (url.hostname) fields.host = decode(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("El puerto no es válido.");
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
    notes.push(`sslmode=${mode} no existe en Hyrax; elige el cifrado a mano.`);
  } else if (mode) {
    throw new Error(`sslmode=${mode} no es un valor conocido.`);
  } else {
    notes.push("La cadena no indica sslmode; revisa el cifrado.");
  }
  const root = url.searchParams.get("sslrootcert");
  if (root) fields.caCertPath = root;

  if (!fields.host) {
    throw new Error("Falta el host. Hyrax se conecta por TCP: no admite sockets Unix ni cadenas sin host (postgresql:///base).");
  }
  return { fields, notes };
}
