# Arquitectura

```
React (src/)  ──invoke──▶  Tauri commands (src-tauri/src/commands.rs)
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
                 db.rs        profiles.rs      models.rs
          (tokio-postgres)   (profiles.json)   (DTOs serde)
```

- `db.rs`: toda la lógica contra Postgres, sin dependencia de Tauri (testeable sola).
- `commands.rs`: capa fina; mantiene `Sessions` (mapa id de conexión → `Arc<Client>`).
- `profiles.rs`: lectura/escritura atómica (archivo temporal + rename) de las conexiones guardadas.
- UI: `App` (pestañas y estado global), `Sidebar` (árbol con caché por conexión), `TableTab`, `SqlTab`, `ResultGrid`, `ConnectionDialog`.

## Decisiones y trade-offs

**Protocolo simple (`simple_query`) para datos.** Devuelve cada valor como texto, soporta varios statements y no exige conocer los tipos. Se evita escribir un conversor para cada tipo de Postgres (numeric, arrays, jsonb, rangos, geométricos…). Costo: sin tipos en la UI (no se puede alinear números ni ordenar en cliente) y sin parámetros enlazados, por lo que los identificadores se escapan con `quote_ident` (comillas dobles duplicadas). Los metadatos sí usan consultas parametrizadas.

**`tokio-postgres` en lugar de `sqlx`.** `sqlx` valida tipos en compilación pero asume esquema conocido; aquí el esquema es arbitrario en tiempo de ejecución, así que `tokio-postgres` es más directo y ligero.

**Una sesión por (conexión, base de datos).** Postgres no permite cambiar de base dentro de una sesión, así que cada base abierta en el árbol es una conexión TCP propia, creada al hacer clic y cerrada al desconectar el servidor. La clave de sesión es `<idPerfil>::<base>`. Un `Client` por sesión, compartido entre pestañas; las consultas se multiplexan sobre la misma conexión (se serializan). Simple; sin pool. Una consulta larga bloquea a las demás de esa conexión hasta la etapa de cancelación.

**Modo solo lectura con `default_transaction_read_only`.** Se aplica con `SET` al abrir la sesión (no como opción de arranque, para que funcione detrás de pgbouncer). Postgres mismo rechaza INSERT/UPDATE/DELETE/DDL con SQLSTATE 25006 y PgDesk añade una explicación. Es un guardarraíl contra errores, no una frontera de seguridad: el usuario puede desactivarlo con SQL. Habilitar escritura exige confirmación explícita y vuelve a solo lectura con un clic. Por defecto las conexiones nuevas son de solo lectura.

**Streaming con tope.** `simple_query_raw` entrega un stream: se guardan 1.000 filas, se siguen contando hasta 100.000 y entonces se cancela la consulta en el servidor. Memoria acotada a costa de que el total sea una cota inferior ("100.000+"). Alternativa descartada: cursores del servidor (`DECLARE`/`FETCH`), que exigen partir el script en sentencias.

**Cancelación y timeout.** Cada sesión guarda su `CancelToken`; cancelar abre una conexión auxiliar (con TLS si la sesión lo usa) y envía la petición de cancelación. El timeout es `statement_timeout` de la sesión, fijado antes de cada ejecución (60 s por defecto en el editor, configurable). Limitación: la petición de cancelación apunta a lo que corra en ese momento en el backend; si llega tarde puede afectar a la consulta siguiente.

**Editor CodeMirror 6.** Se eligió sobre Monaco por tamaño y porque el dialecto PostgreSQL y el autocompletado por esquema ya vienen en `@codemirror/lang-sql`. El esquema (tablas y columnas de todos los schemas no del sistema, tope 3000 tablas) se pide una vez por pestaña con una sola consulta a `pg_attribute`, y se inyecta reconfigurando el lenguaje. El tema usa variables CSS, así que sigue el tema claro/oscuro sin recargar.

**Explicar y Analizar.** `EXPLAIN` no ejecuta la consulta y siempre está disponible. `EXPLAIN ANALYZE` sí la ejecuta (un `UPDATE` se aplicaría), por eso el botón solo se habilita en modo solo lectura, donde Postgres rechaza las escrituras. El plan llega como filas de una columna `QUERY PLAN` y se muestra como texto.

**Historial en `localStorage`, por servidor.** Es una comodidad por equipo, no un dato crítico: puede perderse al limpiar datos del navegador embebido. Se deduplica por texto y se limita a 100 entradas. Las consultas con contraseñas en el SQL quedarían guardadas en claro, igual que en cualquier historial de cliente SQL.

**Formateo con `sql-formatter`.** Dialecto PostgreSQL, palabras clave en mayúsculas. Si falla el análisis se muestra el error y el texto no se toca.

**Filtros en el servidor con literales escapados.** `simple_query` no admite parámetros, así que los valores se insertan como literales: comillas simples duplicadas y, si hay barras invertidas, forma `E'...'` con la barra duplicada (correcto con cualquier valor de `standard_conforming_strings`); los nombres de columna pasan por `quote_ident`; el carácter NUL se rechaza. `contiene` y `empieza por` usan `columna::text ILIKE` escapando `%`, `_` y `\`; las comparaciones (`=`, `>`, …) son tipadas, así que `>5` sobre un entero compara números y `>2026-01-01` sobre una fecha compara fechas (si el valor no es válido para el tipo, Postgres devuelve su error). Se descartó una caja de WHERE libre: con multi-statement permitiría ejecutar sentencias arbitrarias desde la vista de tabla.

**Exportación en streaming.** El servidor envía las filas, y PgDesk las escribe directamente al archivo sin acumularlas en memoria, así que se puede exportar una tabla de millones de filas. Antes de empezar se hace un `prepare` para validar que es una sola sentencia que devuelve filas y para conocer los tipos de las columnas: así el JSON lleva números y booleanos reales (`2.50` se conserva tal cual) y el JSON/JSONB se incrusta como estructura. Si falla o se cancela, se borra el archivo parcial. CSV con BOM porque Excel lo necesita para leer UTF-8; NULL sale como celda vacía (el CSV no distingue NULL de cadena vacía). El destino lo elige el usuario con el diálogo nativo (`tauri-plugin-dialog`, permiso `dialog:allow-save`).

**Conteo estimado + exacto bajo demanda.** `count(*)` es O(n) en Postgres; se muestra `reltuples` (instantáneo, aproximado, `-1` si nunca se analizó) y un botón para el exacto.

**Paginación con `LIMIT/OFFSET`.** Sencilla y suficiente; degrada en offsets muy grandes. Alternativa futura: paginación por keyset usando la PK.

**Credenciales en `profiles.json` (texto plano) en v0.1.** Decisión de alcance, no de diseño final: el reemplazo es el almacén del sistema operativo (etapa 5 pendiente).

**TLS con `native-tls` (SChannel en Windows).** Sin OpenSSL ni dependencias nativas externas. `require` acepta certificados no verificados, igual que `sslmode=require` de libpq.

**Tauri sobre Electron.** Binario pequeño y backend nativo en Rust; costo: dependencia de WebView2 y curva de Rust en la capa de datos.
