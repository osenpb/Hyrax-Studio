import { describe, expect, it } from "vitest";
import { detectEngine, parseConnectionString, parseMongoUri } from "./connstring";

describe("parseConnectionString", () => {
  it("lee todas las partes", () => {
    const { fields, notes } = parseConnectionString(
      "postgresql://ana:s3cr3t@db.example.com:6543/ventas?sslmode=verify-full&sslrootcert=C:/ca.pem",
    );
    expect(fields).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "ana",
      password: "s3cr3t",
      database: "ventas",
      sslMode: "verify",
      caCertPath: "C:/ca.pem",
    });
    expect(notes).toEqual([]);
  });

  it("decodifica caracteres especiales en usuario y clave", () => {
    const { fields } = parseConnectionString("postgres://a%40b:p%3Aw%2Fd%23@h/db?sslmode=require");
    expect(fields.user).toBe("a@b");
    expect(fields.password).toBe("p:w/d#");
    expect(fields.sslMode).toBe("require");
  });

  it("acepta partes omitidas y avisa del cifrado", () => {
    const { fields, notes } = parseConnectionString("postgresql://localhost");
    expect(fields).toEqual({ host: "localhost" });
    expect(notes[0]).toMatch(/sslmode/);
  });

  it("no inventa un modo SSL para prefer/allow", () => {
    const { fields, notes } = parseConnectionString("postgresql://h/db?sslmode=prefer");
    expect(fields.sslMode).toBeUndefined();
    expect(notes[0]).toMatch(/prefer/);
  });

  it("acepta IPv6", () => {
    expect(parseConnectionString("postgresql://u@[::1]:5433/d").fields.host).toBe("::1");
  });

  it("conserva el puerto 80 y rechaza las cadenas sin host", () => {
    expect(parseConnectionString("postgresql://h:80/db?sslmode=disable").fields.port).toBe(80);
    expect(() => parseConnectionString("postgresql:///midb")).toThrow(/host/);
    expect(() => parseConnectionString("postgresql://u@/midb")).toThrow(/host|válida/);
  });

  it("rechaza lo que no es una cadena postgres", () => {
    expect(() => parseConnectionString("mysql://h/db")).toThrow(/postgresql/);
    expect(() => parseConnectionString("postgresql://")).toThrow();
    expect(() => parseConnectionString("postgresql://h:99999/db")).toThrow(/puerto|válida/);
    expect(() => parseConnectionString("postgresql://h/db?sslmode=banana")).toThrow(/sslmode/);
    expect(() => parseConnectionString("postgresql://u:%E0%A4%A@h/db")).toThrow(/codificados/);
  });
});

describe("detectEngine", () => {
  it("deduce el motor por el esquema", () => {
    expect(detectEngine("postgresql://h/db")).toBe("postgres");
    expect(detectEngine("  POSTGRES://h/db")).toBe("postgres");
    expect(detectEngine("mongodb://h")).toBe("mongodb");
    expect(detectEngine("mongodb+srv://c.example.net")).toBe("mongodb");
    expect(detectEngine("mysql://h")).toBeNull();
    expect(detectEngine("hola")).toBeNull();
  });
});

describe("parseMongoUri", () => {
  it("lee una cadena con varios nodos, usuario codificado y opciones", () => {
    const { fields, mongo, notes } = parseMongoUri(
      "mongodb://ana:p%40ss%3Aw@db1.example.com:27017,db2.example.com:27018/ventas?replicaSet=rs0&authSource=admin&tls=true&tlsCAFile=C:/ca.pem",
    );
    expect(fields).toMatchObject({
      host: "db1.example.com",
      port: 27017,
      user: "ana",
      password: "p@ss:w",
      database: "ventas",
      sslMode: "verify",
      caCertPath: "C:/ca.pem",
    });
    expect(mongo).toMatchObject({ srv: false, extraHosts: "db2.example.com:27018", replicaSet: "rs0", authSource: "admin" });
    expect(notes).toEqual([]);
  });

  it("mongodb+srv (Atlas): TLS verificado por omisión y sin puerto", () => {
    const { fields, mongo } = parseMongoUri("mongodb+srv://u:x@cluster0.abcde.mongodb.net/?retryWrites=true");
    expect(mongo.srv).toBe(true);
    expect(fields.host).toBe("cluster0.abcde.mongodb.net");
    expect(fields.port).toBeUndefined();
    expect(fields.sslMode).toBe("verify");
  });

  it("avisa de los parámetros que no usa en vez de aplicarlos en silencio", () => {
    const { notes } = parseMongoUri("mongodb+srv://c.example.net/?retryWrites=true&w=majority");
    expect(notes.join(" ")).toMatch(/retryWrites, w/);
  });

  it("sin TLS en la cadena: lo deja desactivado y avisa; tls=false y tlsAllowInvalidCertificates se respetan", () => {
    const plain = parseMongoUri("mongodb://localhost");
    expect(plain.fields).toMatchObject({ host: "localhost", port: 27017, sslMode: "disable" });
    expect(plain.notes[0]).toMatch(/TLS/);
    expect(parseMongoUri("mongodb://h/?tls=false").fields.sslMode).toBe("disable");
    expect(parseMongoUri("mongodb://h/?tls=true&tlsAllowInvalidCertificates=true").fields.sslMode).toBe("require");
  });

  it("acepta usuario sin contraseña, IPv6 y puerto por omisión", () => {
    const { fields } = parseMongoUri("mongodb://soloUsuario@[::1]/x");
    expect(fields).toMatchObject({ user: "soloUsuario", host: "[::1]", port: 27017, database: "x" });
    expect(fields.password).toBeUndefined();
  });

  it("rechaza lo que no es válido", () => {
    expect(() => parseMongoUri("postgresql://h/db")).toThrow(/mongodb/);
    expect(() => parseMongoUri("mongodb://")).toThrow();
    expect(() => parseMongoUri("mongodb://h:99999/db")).toThrow(/puerto/);
    expect(() => parseMongoUri("mongodb+srv://h:27017/db")).toThrow(/srv/);
    expect(() => parseMongoUri("mongodb+srv://a,b/db")).toThrow(/srv/);
    expect(() => parseMongoUri("mongodb://u:p@ss@h/db")).toThrow(/codificados/);
    expect(() => parseMongoUri("mongodb://u:%E0%A4%A@h/db")).toThrow(/codificados/);
    expect(() => parseMongoUri("mongodb://h/?directConnection=true&tls=true")).not.toThrow();
    expect(() => parseMongoUri("mongodb+srv://c.example.net/?directConnection=true")).toThrow(/directConnection/);
  });
});
