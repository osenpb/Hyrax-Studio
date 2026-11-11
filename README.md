# PgDesk

Cliente de escritorio para PostgreSQL con las funciones esenciales de DataGrip y la ligereza de Rust. Rust + Tauri 2 en el backend, React + TypeScript en la interfaz.

## Qué hace

- **Conexiones guardadas** con la contraseña en el almacén de credenciales del sistema, TLS con verificación de certificado, y marca de **producción**.
- **Navegador** de servidor → bases de datos → schemas → tablas/vistas → columnas, con filtro.
- **Visor de tablas**: paginación, orden por varias columnas, filtros por columna (`>5`, `=x`, `^x`, `null`…), conteo estimado y exacto, estructura, selección y copia de filas, inspector de celdas con JSON formateado.
- **Edición de datos** segura: los cambios (celdas, filas nuevas, filas eliminadas) quedan pendientes, se revisa el SQL y se aplican todos juntos en una transacción, con control de cambios concurrentes.
- **Editor SQL** con resaltado, autocompletado de tablas y columnas, historial, formato, Explicar/Analizar, límite de tiempo, cancelar y "Probar (ROLLBACK)".
- **Exportar** tablas y consultas a CSV, JSON o SQL INSERT, en streaming.
- **Seguridad pensada para producción**: solo lectura por defecto, escritura con confirmación y caducidad, aviso ante `DELETE`/`UPDATE` sin `WHERE`, `DROP` y `TRUNCATE`. Ver [docs/SEGURIDAD.md](docs/SEGURIDAD.md).
- Tema claro, oscuro o automático.

## Requisitos

Rust (MSVC en Windows), Node 20+, WebView2 (incluido en Windows 11).

## Uso

```
npm install
npm run tauri dev      # desarrollo
npm run tauri build    # instalador
```

## Pruebas

```
npm test                         # interfaz, con backend simulado
cd src-tauri && cargo test       # unitarias del backend
```

Las pruebas de integración del backend están marcadas `#[ignore]` y necesitan servidores reales. Las de lectura usan `PGDESK_TEST_HOST/PORT/DB/USER/PASSWORD`. Las de **escritura** usan `PGDESK_WRITE_TEST_*` y se niegan a correr si la base no se llama `scratch`: úsalas solo con un Postgres desechable. Las de TLS necesitan además `PGDESK_TLS_CA_PATH`.

```
cargo test -- --include-ignored
```

## Uso en producción

Resumen (detalle en [docs/SEGURIDAD.md](docs/SEGURIDAD.md)):

1. Conéctate con una cuenta de base de datos **sin permisos de escritura**: es la única barrera real.
2. Elige "Cifrado y verificar el certificado".
3. Marca la conexión como producción.
4. Habilita la escritura solo cuando haga falta y revisa siempre el SQL antes de aplicar.

## Documentación

- [docs/ROADMAP.md](docs/ROADMAP.md): hoja de ruta.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): estructura y decisiones.
- [docs/SEGURIDAD.md](docs/SEGURIDAD.md): revisión de seguridad.
- [SECURITY.md](SECURITY.md): cómo informar vulnerabilidades.
