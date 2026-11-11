# PgDesk

Cliente de escritorio para PostgreSQL (estilo DBeaver, mínimo). Rust + Tauri 2 en el backend, React + TypeScript en la UI.

## Qué hace (v0.1)

- Gestor de conexiones guardadas (host, puerto, base, usuario, contraseña, SSL opcional) con botón de prueba.
- Navegador en árbol: conexión → schemas → Tablas / Vistas / Vistas materializadas / Foráneas → columnas (tipo, PK, nulabilidad). Carga perezosa y filtro por nombre.
- Visor de tabla: paginación (50–1000), orden por columna (clic en cabecera), conteo estimado y conteo exacto bajo demanda, inspector de celda con copiar, pestaña Estructura.
- Editor SQL: ejecución con Ctrl+Enter (o solo la selección), varios statements con resultados en subpestañas, tiempos, errores de Postgres con detalle y sugerencia.
- Filtros por columna en el visor de tablas (con operadores como `>5`, `=x`, `^x`, `null`) y exportación a CSV, JSON o SQL INSERT, tanto de tablas completas como de consultas.
- Editor con resaltado y autocompletado de tablas y columnas, historial por servidor, formateo SQL, Explicar y Analizar con el plan en texto.
- Seguridad y robustez: conexiones en solo lectura por defecto (habilitar escritura pide confirmación), cancelar consulta en curso, límite de tiempo configurable y resultados grandes en streaming con tope.
- Tema claro, oscuro o automático.

## Requisitos

Rust (MSVC en Windows), Node 20+, WebView2 (incluido en Windows 11).

## Uso

```
npm install
npm run tauri dev      # desarrollo
npm run tauri build    # instalador
```

Pruebas de interfaz: `npm test` (vitest con backend simulado).

Pruebas del backend (los de integración están `#[ignore]` y necesitan un servidor real; solo leen, el de solo lectura comprueba que Postgres rechaza una escritura):

```
cd src-tauri
cargo test
PGDESK_TEST_HOST=localhost PGDESK_TEST_PORT=5432 PGDESK_TEST_DB=db PGDESK_TEST_USER=u PGDESK_TEST_PASSWORD=p cargo test -- --include-ignored
```

## Documentación

- `docs/ROADMAP.md`: etapas y estado.
- `docs/ARQUITECTURA.md`: estructura y decisiones.
- Notas persistentes del proyecto: vault de Obsidian, `07 - Proyectos/pgdesk/`.
