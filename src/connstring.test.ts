import { describe, expect, it } from "vitest";
import { parseConnectionString } from "./connstring";

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
